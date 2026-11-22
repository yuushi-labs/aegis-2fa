package com.yuushilabs.zekey.data

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.yuushilabs.zekey.core.VaultEnvelope
import com.yuushilabs.zekey.core.VaultJson
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/** 接続先はハードコード（設定でサーバー URL を変える UI は作らない）。 */
object ServerConfig {
    const val BASE_URL = "https://yuushi0911.xsrv.jp/zekey"
    const val API_PREFIX = "$BASE_URL/api/vault"
    const val HEALTH_URL = "$BASE_URL/api/health"
    const val APP_NAME = "Zekey 2FA"
}

/**
 * 2xx 以外の応答。`error` はサーバー（Node 版 / PHP 版）が返す機械可読な理由で、
 * 画面には出さずに [SyncFailure] で日本語に置き換える。
 */
class SyncHttpException(
    val status: Int,
    val code: String? = null,
    val issues: List<String> = emptyList(),
) : Exception(buildString {
    append("sync request failed: ").append(status)
    if (!code.isNullOrBlank()) append(' ').append(code)
})

class SyncConflictException(val currentRevision: Int) : Exception("sync conflict")

class SyncNotFoundException : Exception("vault not found")

/**
 * 同期 API クライアント。送るのは暗号文封筒だけ（Web 版 `src/lib/syncClient.ts` と同じ）。
 * `Authorization: Bearer <token>`、`PUT` の body は `{ envelope, revision }`。
 *
 * PUT body の形はサーバー側の検証（PHP 版 `Validation.php` / Node 版 `server/routes/vault.ts`）と
 * 完全一致している必要がある。[SyncBodies.putBody] が唯一の組み立て場所で、
 * `SyncBodyContractTest` がキーの過不足を検査する。
 */
class SyncApi(
    private val baseUrl: String = ServerConfig.API_PREFIX,
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 30_000,
) : SyncTransport {

    data class RemoteMeta(val revision: Int, val updatedAt: String)

    override fun get(vaultId: String, token: String): RemoteVaultSnapshot {
        val response = request("GET", "$baseUrl/$vaultId", token, null)
        if (response.status == 404) throw SyncNotFoundException()
        if (response.status !in 200..299) throw httpError(response)
        val root = parse(response.body) ?: throw SyncHttpException(response.status, "invalid_response")
        val envelopeJson = root.getAsJsonObject("envelope")
            ?: throw SyncHttpException(response.status, "invalid_response")
        val envelope = VaultJson.readEnvelope(envelopeJson)
        val revision = root.get("revision")?.takeIf { it.isJsonPrimitive }?.asInt ?: envelope.revision
        return RemoteVaultSnapshot(envelope = envelope, revision = revision)
    }

    fun getMeta(vaultId: String, token: String): RemoteMeta {
        val response = request("GET", "$baseUrl/$vaultId/meta", token, null)
        if (response.status == 404) throw SyncNotFoundException()
        if (response.status !in 200..299) throw httpError(response)
        val root = parse(response.body) ?: throw SyncHttpException(response.status, "invalid_response")
        return RemoteMeta(
            revision = root.get("revision")?.asInt ?: 0,
            updatedAt = root.get("updatedAt")?.asString.orEmpty(),
        )
    }

    override fun put(vaultId: String, token: String, envelope: VaultEnvelope, baseRevision: Int): Int {
        val body = SyncBodies.putBody(envelope, baseRevision)
        val response = request("PUT", "$baseUrl/$vaultId", token, body)
        if (response.status == 409) {
            val root = parse(response.body)
            throw SyncConflictException(root?.get("currentRevision")?.asInt ?: baseRevision)
        }
        if (response.status == 404) throw SyncNotFoundException()
        if (response.status !in 200..299) throw httpError(response)
        val root = parse(response.body)
        return root?.get("revision")?.asInt ?: (baseRevision + 1)
    }

    fun remove(vaultId: String, token: String) {
        val response = request("DELETE", "$baseUrl/$vaultId", token, null)
        if (response.status == 404) return
        if (response.status !in 200..299) throw httpError(response)
    }

    fun isHealthy(): Boolean = try {
        val connection = URL(ServerConfig.HEALTH_URL).openConnection() as HttpURLConnection
        connection.connectTimeout = connectTimeoutMs
        connection.readTimeout = readTimeoutMs
        connection.requestMethod = "GET"
        val code = connection.responseCode
        connection.disconnect()
        code in 200..299
    } catch (_: Exception) {
        false
    }

    private data class Response(val status: Int, val body: String)

    /** エラー応答の `error` / `issues` を拾って例外にする（画面の日本語化に使う）。 */
    private fun httpError(response: Response): SyncHttpException {
        val failure = SyncErrors.fromBody(response.status, response.body)
        return SyncHttpException(response.status, failure.serverCode, failure.issues)
    }

    private fun request(method: String, url: String, token: String, body: String?): Response {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            instanceFollowRedirects = false
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Accept", "application/json")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=UTF-8")
            }
        }
        try {
            if (body != null) {
                connection.outputStream.use { stream ->
                    stream.write(body.toByteArray(Charsets.UTF_8))
                }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
            return Response(status, text)
        } finally {
            connection.disconnect()
        }
    }

    private fun parse(body: String) = try {
        if (body.isBlank()) null else JsonParser.parseString(body).takeIf { it.isJsonObject }?.asJsonObject
    } catch (_: Exception) {
        null
    }
}

/** 同期 API の JSON 組み立て（テストから形を検査できるように分けてある）。 */
object SyncBodies {

    /** `PUT /api/vault/:id` の body（`{ envelope, revision }`）。 */
    fun putBody(envelope: VaultEnvelope, revision: Int): String = putBodyJson(envelope, revision).toString()

    fun putBodyJson(envelope: VaultEnvelope, revision: Int): JsonObject {
        val envelopeJson = VaultJson.gson.toJsonTree(envelope)
        val root = JsonObject()
        root.add("envelope", envelopeJson)
        root.addProperty("revision", revision)
        return root
    }
}
