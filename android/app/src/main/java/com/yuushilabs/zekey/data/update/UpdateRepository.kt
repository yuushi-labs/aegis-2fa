package com.yuushilabs.zekey.data.update

import com.yuushilabs.zekey.core.update.ApkDownloader
import com.yuushilabs.zekey.core.update.ApkFiles
import com.yuushilabs.zekey.core.update.AppVersion
import com.yuushilabs.zekey.core.update.GithubRelease
import com.yuushilabs.zekey.core.update.GithubReleaseJson
import com.yuushilabs.zekey.core.update.ReleaseFetcher
import com.yuushilabs.zekey.core.update.UpdateDecision
import com.yuushilabs.zekey.core.update.UpdateInfo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** 1 回の確認の結論。 */
sealed interface CheckOutcome {

    /** 新しいリリースがある。[skipped] は利用者が「後で」を選んだもの。 */
    data class Available(val info: UpdateInfo, val skipped: Boolean) : CheckOutcome

    /** 今が最新。 */
    data object UpToDate : CheckOutcome

    /** 直前の確認から間もないので、何も問い合わせていない。 */
    data object Throttled : CheckOutcome

    /** 確認できなかった。[reason] は手動確認のときだけ画面に出す。 */
    data class Unavailable(val reason: String) : CheckOutcome
}

/**
 * 更新の決まりごと:
 * - 起動とフォアグラウンド復帰のたびに GitHub へ聞く（連続発火だけ
 *   [DEFAULT_AUTO_CHECK_DEBOUNCE_MS] でまとめる）。
 * - 本当に新しいものだけを提示する（同じ・古い・draft・prerelease・APK 無しは出さない）。
 * - APK は `cacheDir/updates/` に置き、インストール後に掃除する。
 *
 * 通信は [ReleaseFetcher] / [ApkDownloader] 越しなので、全部テスト用の偽物で動かせる。
 */
class UpdateRepository(
    private val fetcher: ReleaseFetcher,
    private val downloader: ApkDownloader,
    private val memo: UpdateMemo,
    private val apkDirectory: File,
    val currentVersionName: String,
    private val currentVersionCode: Int,
    private val minCheckIntervalMs: Long = DEFAULT_AUTO_CHECK_DEBOUNCE_MS,
    private val clock: () -> Long = System::currentTimeMillis,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {

    /**
     * 最新リリースを聞く。手動なら必ず問い合わせて失敗理由も返し、
     * 自動なら直近 [minCheckIntervalMs] の重複を省き、失敗しても静かにする。
     */
    suspend fun check(manual: Boolean): CheckOutcome {
        if (!manual) {
            val last = memo.lastCheckedAt()
            if (last != null && clock() - last in 0 until minCheckIntervalMs) {
                return CheckOutcome.Throttled
            }
        }

        val rememberedEtag = memo.releaseEtag()
        val response = fetcher.fetchLatest(rememberedEtag).getOrElse { error ->
            // 失敗も「確認した」として記録し、復帰のたびに再試行しない（手動なら即やり直せる）。
            memo.recordCheck(clock())
            return CheckOutcome.Unavailable(error.message ?: "update check failed")
        }

        if (response.notModified) {
            memo.recordCheck(clock(), etag = response.etag ?: rememberedEtag)
            val body = memo.releaseBody()
                ?: return CheckOutcome.Unavailable("前回のリリース情報がありません")
            val release = GithubReleaseJson.parse(body)
                ?: return CheckOutcome.Unavailable("release JSON を読めませんでした")
            return decide(release)
        }

        val body = response.body
            ?: return CheckOutcome.Unavailable("release JSON を読めませんでした")
        val release = GithubReleaseJson.parse(body)
            ?: return CheckOutcome.Unavailable("release JSON を読めませんでした")
        memo.recordCheck(clock(), etag = response.etag, body = body)
        return decide(release)
    }

    private suspend fun decide(release: GithubRelease): CheckOutcome {
        val info = UpdateDecision.decide(
            currentVersionName = currentVersionName,
            currentVersionCode = currentVersionCode,
            release = release,
        ) ?: return CheckOutcome.UpToDate

        return CheckOutcome.Available(info = info, skipped = memo.skippedVersion() == info.versionName)
    }

    /** このバージョンの APK の置き場所。落とし終えたものは再利用する。 */
    fun apkFileFor(info: UpdateInfo): File = File(
        apkDirectory,
        "zekey-android-${info.versionName.replace(Regex("[^A-Za-z0-9._-]"), "_")}.apk",
    )

    /** 前に落とし終えている APK（あれば）。 */
    fun cachedApk(info: UpdateInfo): File? {
        val file = apkFileFor(info)
        if (!ApkFiles.sizeMatches(file, info.apkSizeBytes)) return null
        if (!ApkFiles.looksLikeApk(file)) return null
        if (!ApkFiles.sha256Matches(file, info.apkSha256)) return null
        return file
    }

    suspend fun download(info: UpdateInfo, onProgress: (Long, Long) -> Unit): Result<File> {
        pruneStaleApks()
        cachedApk(info)?.let { return Result.success(it) }
        return try {
            Result.success(
                downloader.download(
                    url = info.apkUrl,
                    target = apkFileFor(info),
                    expectedBytes = info.apkSizeBytes,
                    expectedSha256 = info.apkSha256,
                    onProgress = onProgress,
                ),
            )
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            Result.failure(error)
        }
    }

    /**
     * 以前の更新の残りを片づける（起動時と、ダウンロードの直前に呼ぶ）。
     *
     * `cacheDir/updates/` は Android が空き容量を必要としたときしか消さないので、
     * 更新後の APK はそのまま残る。ここで
     *  - 実行中のバージョンとそれ以前の APK（もう入れられない／入れた）
     *  - `.part`（中断されたダウンロードの残骸）
     *  - 見覚えのないファイル（1日以上たったもの）
     * を消す。実行中より**新しい** APK は残す（まだ入れていない更新のぶん）。
     */
    suspend fun pruneStaleApks(): List<File> = withContext(ioDispatcher) {
        val running = AppVersion.parse(currentVersionName)
        val removed = mutableListOf<File>()
        val files = apkDirectory.listFiles() ?: return@withContext removed
        for (file in files) {
            if (!file.isFile) continue
            if (isStale(file, running) && file.delete()) removed += file
        }
        removed
    }

    private fun isStale(file: File, running: AppVersion?): Boolean = when {
        file.name.endsWith(PART_SUFFIX) -> true

        file.name.endsWith(".apk", ignoreCase = true) -> {
            val downloaded = AppVersion.parse(file.name.removeSuffix(".apk"))
            downloaded == null || (running != null && downloaded <= running)
        }

        else -> clock() - file.lastModified() > UNKNOWN_FILE_TTL_MS
    }

    suspend fun skip(version: String) = memo.skip(version)

    suspend fun clearSkip() = memo.clearSkip()

    companion object {
        /** 起動直後の復帰など、ほぼ同時の二重発火だけをまとめる。 */
        const val DEFAULT_AUTO_CHECK_DEBOUNCE_MS = 20_000L

        private const val PART_SUFFIX = ".part"

        /** 見覚えのないファイルは 1 日残してから消す。 */
        private const val UNKNOWN_FILE_TTL_MS = 24L * 60L * 60L * 1000L
    }
}
