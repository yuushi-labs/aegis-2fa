package com.yuushilabs.zekey.core.update

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * 最新リリースの応答。
 *
 * [notModified] は「前回の [etag] から変わっていない」の意味。GitHub は 304 を
 * レート制限（未認証で 1 時間 60 回）に数えないので、起動のたびに確認しても消費しない。
 * そのとき [body] は null。
 */
data class ReleaseResponse(
    val body: String?,
    val etag: String?,
    val notModified: Boolean = false,
)

interface ReleaseFetcher {
    suspend fun fetchLatest(etag: String? = null): Result<ReleaseResponse>
}

/**
 * `GET /repos/{owner}/{repo}/releases/latest`。
 * draft と prerelease はこのエンドポイントに出てこない（昇格したものだけが返る）。
 */
class HttpReleaseFetcher(
    private val endpoint: String = DEFAULT_ENDPOINT,
    private val userAgent: String = DEFAULT_USER_AGENT,
    private val connectTimeoutMs: Int = 5_000,
    private val readTimeoutMs: Int = 10_000,
) : ReleaseFetcher {

    override suspend fun fetchLatest(etag: String?): Result<ReleaseResponse> = withContext(Dispatchers.IO) {
        runCatching {
            val connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = connectTimeoutMs
                readTimeout = readTimeoutMs
                instanceFollowRedirects = true
                setRequestProperty("Accept", "application/vnd.github+json")
                setRequestProperty("User-Agent", userAgent)
                setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
                if (!etag.isNullOrBlank()) setRequestProperty("If-None-Match", etag)
            }
            try {
                when (val code = connection.responseCode) {
                    HttpURLConnection.HTTP_NOT_MODIFIED ->
                        ReleaseResponse(body = null, etag = etag, notModified = true)

                    HttpURLConnection.HTTP_OK -> ReleaseResponse(
                        body = readBody(connection),
                        etag = connection.getHeaderField("ETag"),
                    )

                    else -> {
                        val error = connection.errorStream
                            ?.bufferedReader(Charsets.UTF_8)
                            ?.use { it.readText() }
                            ?.take(200)
                            .orEmpty()
                        throw IOException("HTTP $code $error".trim())
                    }
                }
            } finally {
                connection.disconnect()
            }
        }
    }

    private fun readBody(connection: HttpURLConnection): String =
        connection.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
            val buffer = CharArray(8 * 1024)
            val out = StringBuilder()
            while (out.length < MAX_RESPONSE_CHARS) {
                val read = reader.read(buffer)
                if (read < 0) break
                out.appendRange(buffer, 0, read)
            }
            out.toString()
        }

    companion object {
        const val DEFAULT_ENDPOINT = "https://api.github.com/repos/yuushi-labs/zekey-2fa/releases/latest"
        const val DEFAULT_USER_AGENT = "Zekey-2FA-Android"

        /** リリース文書は数 KB。これを超えるものは文書ではない。 */
        private const val MAX_RESPONSE_CHARS = 512 * 1024
    }
}

/** APK をローカルへ落とす（進捗つき）。 */
interface ApkDownloader {
    /**
     * [url] を [target] に保存し、完了したファイルを返す。
     * [onProgress] は（受信バイト, 全体バイト。不明なら 0）。
     */
    suspend fun download(
        url: String,
        target: File,
        expectedBytes: Long,
        expectedSha256: String?,
        onProgress: (Long, Long) -> Unit,
    ): File
}

/** インストーラに渡す前の検査。 */
object ApkFiles {

    /** ZIP の先頭 4 バイト（`PK\u0003\u0004`）。APK は zip、エラーページは違う。 */
    fun looksLikeApk(file: File): Boolean = runCatching {
        file.inputStream().use { input ->
            val header = ByteArray(4)
            if (input.read(header) != 4) return@use false
            header[0] == 'P'.code.toByte() &&
                header[1] == 'K'.code.toByte() &&
                header[2] == 0x03.toByte() &&
                header[3] == 0x04.toByte()
        }
    }.getOrDefault(false)

    fun sizeMatches(file: File, expectedBytes: Long): Boolean =
        file.isFile && file.length() > 0 && (expectedBytes <= 0 || file.length() == expectedBytes)

    fun sha256(file: File): String? = runCatching {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        digest.digest().joinToString("") { byte -> "%02x".format(byte) }
    }.getOrNull()

    /** [expectedSha256] が分かっているときだけ照合する（大文字小文字は問わない）。 */
    fun sha256Matches(file: File, expectedSha256: String?): Boolean {
        val expected = expectedSha256?.trim()?.removePrefix("sha256:")?.takeIf { it.isNotEmpty() } ?: return true
        val actual = sha256(file) ?: return false
        return actual.equals(expected, ignoreCase = true)
    }
}

class HttpApkDownloader(
    private val userAgent: String = HttpReleaseFetcher.DEFAULT_USER_AGENT,
    private val connectTimeoutMs: Int = 10_000,
    private val readTimeoutMs: Int = 30_000,
) : ApkDownloader {

    override suspend fun download(
        url: String,
        target: File,
        expectedBytes: Long,
        expectedSha256: String?,
        onProgress: (Long, Long) -> Unit,
    ): File = withContext(Dispatchers.IO) {
        val directory = target.parentFile
        directory?.mkdirs()
        // 途中で切れたダウンロードを完成品と取り違えないよう、必ず .part 経由で書く。
        val partial = File(directory, target.name + ".part")
        partial.delete()

        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            instanceFollowRedirects = true
            setRequestProperty("Accept", "application/octet-stream")
            setRequestProperty("User-Agent", userAgent)
        }
        try {
            val code = connection.responseCode
            if (code != HttpURLConnection.HTTP_OK) {
                throw IOException("APK download failed: HTTP $code")
            }
            val total = connection.contentLengthLong.takeIf { it > 0 } ?: expectedBytes
            var received = 0L
            connection.inputStream.use { input ->
                partial.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        received += read
                        onProgress(received, total)
                    }
                }
            }
            if (!ApkFiles.sizeMatches(partial, expectedBytes)) {
                throw IOException("APK download did not match: $received bytes")
            }
            if (!ApkFiles.looksLikeApk(partial)) {
                throw IOException("downloaded file is not an APK")
            }
            if (!ApkFiles.sha256Matches(partial, expectedSha256)) {
                throw IOException("APK sha256 mismatch")
            }
            if (target.exists()) target.delete()
            if (!partial.renameTo(target)) {
                partial.copyTo(target, overwrite = true)
                partial.delete()
            }
            target
        } catch (error: Throwable) {
            partial.delete()
            throw error
        } finally {
            connection.disconnect()
        }
    }
}
