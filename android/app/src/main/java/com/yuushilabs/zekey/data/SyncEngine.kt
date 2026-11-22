package com.yuushilabs.zekey.data

import com.yuushilabs.zekey.core.Crypto
import com.yuushilabs.zekey.core.IsoTime
import com.yuushilabs.zekey.core.SyncCode
import com.yuushilabs.zekey.core.VaultData
import com.yuushilabs.zekey.core.VaultEnvelope
import com.yuushilabs.zekey.core.VaultJson
import com.yuushilabs.zekey.core.VaultMerge

/** サーバーにある封筒と、その revision。 */
data class RemoteVaultSnapshot(val envelope: VaultEnvelope, val revision: Int)

/** 同期 API の最小限の口（実装は [SyncApi]、テストは偽物）。 */
interface SyncTransport {
    fun get(vaultId: String, token: String): RemoteVaultSnapshot

    /** [baseRevision] は「送信側が最後にサーバーと一致した revision」。戻りは保存後の revision。 */
    fun put(vaultId: String, token: String, envelope: VaultEnvelope, baseRevision: Int): Int
}

/** 1 回の同期に必要な手元の状態。 */
data class SyncRequest(
    val token: String,
    val envelope: VaultEnvelope,
    /** 最後にサーバーと一致した revision（未同期なら 0）。 */
    val baseRevision: Int,
    /** アンロック中だけ入る平文データ。ロック中は null（暗号文だけ送れる）。 */
    val local: VaultData?,
    /** アンロック中だけ入る DEK。ロック中は null。 */
    val dek: ByteArray?,
)

/** サーバーから取り込んだ内容の内訳（通知用）。 */
data class PullSummary(
    val added: Int = 0,
    val updated: Int = 0,
    /** サーバーの封筒をそのまま採用した（マージで送り直していない）。 */
    val adoptedRemote: Boolean = true,
)

/** 同期の結果、端末に保存すべき状態。 */
data class SyncApplied(
    val envelope: VaultEnvelope,
    /** サーバーと一致した revision。 */
    val revision: Int,
    val updatedAt: String,
    /** 復号済みデータ。ロック中や送信だけのときは null。 */
    val data: VaultData?,
    val pull: PullSummary? = null,
    /** マージ結果を保存したが送信できなかった（次の同期で送る）。 */
    val pendingPush: Boolean = false,
)

sealed interface SyncOutcome {
    data class Synced(val applied: SyncApplied) : SyncOutcome

    data class Conflict(val remoteRevision: Int, val remoteEnvelope: VaultEnvelope) : SyncOutcome

    data class Failed(val failure: SyncFailure) : SyncOutcome
}

/**
 * 同期待ちの理由と、画面に出す日本語。
 *
 * サーバーの `error` コード（`revision_must_advance` など）は捨てずに [serverCode] に残し、
 * 画面には [message] を出す。[debugLabel] は設定画面の「詳細」にだけ出す。
 */
data class SyncFailure(
    val code: String,
    val status: Int? = null,
    val serverCode: String? = null,
    val detail: String? = null,
    /** サーバーの `issues`（どのフィールドが不正か）。デバッグ表示にだけ使う。 */
    val issues: List<String> = emptyList(),
) {
    val message: String
        get() = when (code) {
            "network" -> "サーバーに接続できませんでした。通信状態を確認して、もう一度お試しください。"
            "not_found" -> "同期コードが見つかりません。同期コードを確認するか、同期をやり直してください。"
            "unauthorized" -> "同期コードが受け付けられませんでした。設定から同期コードを確認してください。"
            "invalid_body" -> "同期データの形式がサーバーに受け付けられませんでした。アプリを最新版にしてください。"
            "revision_must_advance" -> "同期の状態がずれていました。もう一度同期すると自動で合わせます。"
            "rate_limited" -> "アクセスが集中しています。少し待ってからもう一度お試しください。"
            "too_large" -> "ボルトが大きすぎて同期できませんでした。"
            "server" -> "サーバー側で問題が起きています。時間をおいてもう一度お試しください。"
            "invalid_key" -> "別のマスターパスワードで作られたボルトと重なりました。同期コードを確認してください。"
            "stale_envelope" -> "同期の準備ができていません。解錠してからもう一度お試しください。"
            "conflict_fetch_failed" -> "他の端末との競合を確認できませんでした。通信状態を確認してください。"
            else -> "同期できませんでした。もう一度お試しください。"
        }

    /** デバッグ用の短い識別子（`http_400 revision_must_advance` など）。 */
    val debugLabel: String
        get() = buildString {
            if (status != null) append("http_").append(status) else append(code)
            if (!serverCode.isNullOrBlank()) append(' ').append(serverCode)
            val extra = detail?.takeIf { it.isNotBlank() }
            if (extra != null) append(' ').append(extra.take(120))
            if (issues.isNotEmpty()) append(' ').append(issues.take(4).joinToString(","))
        }

    companion object {
        fun of(error: Throwable): SyncFailure = when (error) {
            is SyncHttpException -> fromStatus(error.status, error.code, error.issues)
            is SyncNotFoundException -> SyncFailure("not_found", 404, "not_found")
            is SyncConflictException -> SyncFailure("conflict_fetch_failed", 409, "conflict")
            else -> SyncFailure("network", null, null, error.message)
        }

        /** HTTP のステータスとサーバーの `error` から、画面に出さない内部コードを作る。 */
        fun fromStatus(
            status: Int,
            serverCode: String? = null,
            issues: List<String> = emptyList(),
        ): SyncFailure {
            val code = when {
                status == 401 -> "unauthorized"
                status == 404 -> "not_found"
                status == 413 -> "too_large"
                status == 429 -> "rate_limited"
                status == 400 && serverCode == "revision_must_advance" -> "revision_must_advance"
                status == 400 -> "invalid_body"
                status in 500..599 -> "server"
                else -> "http"
            }
            return SyncFailure(code, status, serverCode, issues = issues)
        }
    }
}

/** エラー応答の本文（`{"error":"revision_must_advance","issues":[...]}`）の読み取り。 */
object SyncErrors {

    fun fromBody(status: Int, body: String): SyncFailure {
        val root = try {
            if (body.isBlank()) null else com.google.gson.JsonParser.parseString(body).takeIf { it.isJsonObject }?.asJsonObject
        } catch (_: Exception) {
            null
        }
        val code = root?.get("error")?.takeIf { it.isJsonPrimitive }?.asString
        val issues = ArrayList<String>()
        val issuesJson = root?.get("issues")?.takeIf { it.isJsonArray }?.asJsonArray
        if (issuesJson != null) {
            for (element in issuesJson) {
                if (element.isJsonPrimitive) issues.add(element.asString)
            }
        }
        return SyncFailure.fromStatus(status, code, issues)
    }
}

/**
 * 同期の判断そのもの。Android に依存しないので、偽の [SyncTransport] で全分岐を試せる。
 *
 * 送る前に必ず「ローカルに未送信の変更があるか」を見る。`PUT` は
 * `envelope.revision > baseRevision` のときだけ行い、そうでなければ `GET` で
 * サーバーの状態を取りに行く（サーバーは `nextRevision <= baseRevision` を
 * `400 revision_must_advance` で拒否するので、ここを通さない）。
 */
class SyncEngine(private val transport: SyncTransport) {

    fun sync(request: SyncRequest): SyncOutcome {
        val vaultId = SyncCode.deriveVaultId(request.token)
        val hasLocalChange = request.envelope.revision > request.baseRevision
        return if (hasLocalChange) {
            pushLocalFirst(vaultId, request)
        } else {
            pullServerFirst(vaultId, request)
        }
    }

    // --------------------------------------------------------------- ローカル優先

    private fun pushLocalFirst(vaultId: String, request: SyncRequest): SyncOutcome {
        val sent = request.envelope
        return try {
            val revision = transport.put(vaultId, request.token, sent, request.baseRevision)
            SyncOutcome.Synced(
                SyncApplied(
                    envelope = sent,
                    revision = revision,
                    updatedAt = sent.updatedAt,
                    data = request.local,
                ),
            )
        } catch (conflict: SyncConflictException) {
            resolveConflict(vaultId, request, conflict.currentRevision)
        } catch (notFound: SyncNotFoundException) {
            uploadAsNew(vaultId, request)
        } catch (error: SyncHttpException) {
            if (error.status == 400 && error.code == "revision_must_advance") {
                // サーバーの前提と食い違ったら、取り込み直して合わせる（同じ送信を繰り返さない）。
                pullServerFirst(vaultId, request)
            } else {
                SyncOutcome.Failed(SyncFailure.of(error))
            }
        } catch (error: Exception) {
            SyncOutcome.Failed(SyncFailure.of(error))
        }
    }

    /** サーバーにまだ無い（消えた）ボルト: base 0 で作り直す。 */
    private fun uploadAsNew(vaultId: String, request: SyncRequest): SyncOutcome = try {
        val prepared = ensureRevision(request, minimum = 1)
            ?: return SyncOutcome.Failed(SyncFailure("stale_envelope"))
        val revision = transport.put(vaultId, request.token, prepared.envelope, 0)
        SyncOutcome.Synced(
            SyncApplied(
                envelope = prepared.envelope,
                revision = revision,
                updatedAt = prepared.envelope.updatedAt,
                data = prepared.local,
            ),
        )
    } catch (error: Exception) {
        SyncOutcome.Failed(SyncFailure.of(error))
    }

    // ---------------------------------------------------------------- サーバー優先

    private fun pullServerFirst(vaultId: String, request: SyncRequest): SyncOutcome {
        val remote = try {
            transport.get(vaultId, request.token)
        } catch (notFound: SyncNotFoundException) {
            return uploadAsNew(vaultId, request)
        } catch (error: Exception) {
            return SyncOutcome.Failed(SyncFailure.of(error))
        }

        return when {
            remote.revision == request.baseRevision -> SyncOutcome.Synced(
                SyncApplied(
                    envelope = request.envelope,
                    revision = remote.revision,
                    updatedAt = remote.envelope.updatedAt,
                    data = request.local,
                ),
            )

            // サーバーが巻き戻っている（復元など）: 手元の方が新しいので送り返す。
            remote.revision < request.baseRevision -> pushAfterPull(
                vaultId,
                request,
                envelope = request.envelope,
                base = remote.revision,
                data = request.local,
            )

            else -> adoptRemote(vaultId, request, remote)
        }
    }

    /** サーバーが新しい: ロック中は暗号文をそのまま、アンロック中はマージして必要なら送る。 */
    private fun adoptRemote(
        vaultId: String,
        request: SyncRequest,
        remote: RemoteVaultSnapshot,
    ): SyncOutcome {
        val dek = request.dek
        val local = request.local
        if (dek == null || local == null) {
            // 解錠していないので中身は比べられない。封筒だけ合わせる（次の解錠で読める）。
            return SyncOutcome.Synced(
                SyncApplied(
                    envelope = remote.envelope,
                    revision = remote.revision,
                    updatedAt = remote.envelope.updatedAt,
                    data = null,
                    pull = PullSummary(adoptedRemote = true),
                ),
            )
        }

        val remoteData = try {
            VaultJson.parse(Crypto.decryptWithDek(remote.envelope, dek))
        } catch (error: Exception) {
            return SyncOutcome.Failed(
                SyncFailure("invalid_key", null, null, error.message),
            )
        }

        val merged = VaultMerge.merge(local, remoteData)
        val mergedText = VaultJson.serialize(merged.data)
        if (mergedText == VaultJson.serialize(remoteData)) {
            return SyncOutcome.Synced(
                SyncApplied(
                    envelope = remote.envelope,
                    revision = remote.revision,
                    updatedAt = remote.envelope.updatedAt,
                    data = remoteData,
                    pull = PullSummary(adoptedRemote = true),
                ),
            )
        }

        val nextRevision = remote.revision + 1
        val next = try {
            Crypto.updateEnvelopeData(remote.envelope, dek, mergedText, nextRevision)
        } catch (error: Exception) {
            return SyncOutcome.Failed(SyncFailure("invalid_key", null, null, error.message))
        }

        return try {
            val revision = transport.put(vaultId, request.token, next, remote.revision)
            SyncOutcome.Synced(
                SyncApplied(
                    envelope = next,
                    revision = revision,
                    updatedAt = next.updatedAt,
                    data = merged.data,
                    pull = PullSummary(merged.added, merged.updated, adoptedRemote = true),
                ),
            )
        } catch (error: Exception) {
            // マージ結果は失わない: 手元に保存して、次の同期で送る。
            SyncOutcome.Synced(
                SyncApplied(
                    envelope = next,
                    revision = remote.revision,
                    updatedAt = next.updatedAt,
                    data = merged.data,
                    pull = PullSummary(merged.added, merged.updated, adoptedRemote = true),
                    pendingPush = true,
                ),
            )
        }
    }

    private fun pushAfterPull(
        vaultId: String,
        request: SyncRequest,
        envelope: VaultEnvelope,
        base: Int,
        data: VaultData?,
    ): SyncOutcome = try {
        val revision = transport.put(vaultId, request.token, envelope, base)
        SyncOutcome.Synced(
            SyncApplied(
                envelope = envelope,
                revision = revision,
                updatedAt = envelope.updatedAt,
                data = data,
            ),
        )
    } catch (error: Exception) {
        SyncOutcome.Failed(SyncFailure.of(error))
    }

    // ------------------------------------------------------------------ 競合

    private fun resolveConflict(vaultId: String, request: SyncRequest, currentRevision: Int): SyncOutcome {
        val remote = try {
            transport.get(vaultId, request.token)
        } catch (notFound: SyncNotFoundException) {
            return uploadAsNew(vaultId, request)
        } catch (error: Exception) {
            return SyncOutcome.Failed(SyncFailure("conflict_fetch_failed", null, null, error.message))
        }

        val sent = request.envelope
        val same = remote.revision == sent.revision &&
            remote.envelope.data.iv == sent.data.iv &&
            remote.envelope.data.ciphertext == sent.data.ciphertext
        if (same) {
            return SyncOutcome.Synced(
                SyncApplied(
                    envelope = sent,
                    revision = remote.revision,
                    updatedAt = sent.updatedAt,
                    data = request.local,
                ),
            )
        }
        return SyncOutcome.Conflict(
            remoteRevision = remote.revision.takeIf { it > 0 } ?: currentRevision,
            remoteEnvelope = remote.envelope,
        )
    }

    // ------------------------------------------------------------------ 補助

    private data class Prepared(val envelope: VaultEnvelope, val local: VaultData?)

    /**
     * PUT に出す封筒の revision を [minimum] 以上にする。
     *
     * revision はデータの AAD に入っているので、書き換えるには DEK で暗号化し直す必要がある。
     * ロック中に直せない状態（revision 0 の封筒）は null を返し、呼び出し側が失敗にする
     * （`envelope.revision == 0` のまま送るとサーバーが 400 を返す）。
     */
    private fun ensureRevision(request: SyncRequest, minimum: Int): Prepared? {
        val envelope = request.envelope
        if (envelope.revision >= minimum) return Prepared(envelope, request.local)

        val dek = request.dek ?: return null
        val local = request.local ?: return null
        val next = Crypto.updateEnvelopeData(
            envelope = envelope,
            dek = dek,
            plaintext = VaultJson.serialize(local),
            revision = minimum,
            updatedAt = IsoTime.now(),
        )
        return Prepared(next, local)
    }
}
