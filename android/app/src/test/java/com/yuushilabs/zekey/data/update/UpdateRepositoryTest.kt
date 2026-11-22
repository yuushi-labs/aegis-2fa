package com.yuushilabs.zekey.data.update

import com.yuushilabs.zekey.core.update.ApkDownloader
import com.yuushilabs.zekey.core.update.ReleaseFetcher
import com.yuushilabs.zekey.core.update.ReleaseResponse
import com.yuushilabs.zekey.core.update.UpdateInfo
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** 更新確認のポリシー（デバウンス・304・掃除・ダウンロード）を、通信の偽物で確かめる。 */
class UpdateRepositoryTest {

    @get:Rule
    val temp = TemporaryFolder()

    private val releaseJson = """
        {
          "tag_name": "v1.1.2",
          "name": "Zekey 2FA v1.1.2",
          "body": "## Zekey 2FA v1.1.2\n\nversionCode: 4\n\n- 同期の http_400 を修正\n",
          "html_url": "https://github.com/yuushi-labs/zekey-2fa/releases/tag/v1.1.2",
          "prerelease": false,
          "draft": false,
          "assets": [
            {
              "name": "zekey-android-v1.1.2.apk",
              "browser_download_url": "https://example.com/zekey-android-v1.1.2.apk",
              "size": 1048576
            }
          ]
        }
    """.trimIndent()

    private class FakeFetcher(var result: () -> Result<ReleaseResponse>) : ReleaseFetcher {
        val etags = mutableListOf<String?>()
        var calls = 0

        override suspend fun fetchLatest(etag: String?): Result<ReleaseResponse> {
            calls += 1
            etags += etag
            return result()
        }
    }

    private class FakeMemo : UpdateMemo {
        var checkedAt: Long? = null
        var etag: String? = null
        var body: String? = null
        var skipped: String? = null

        override suspend fun lastCheckedAt(): Long? = checkedAt
        override suspend fun releaseEtag(): String? = etag
        override suspend fun releaseBody(): String? = body
        override suspend fun skippedVersion(): String? = skipped

        override suspend fun recordCheck(at: Long, etag: String?, body: String?) {
            checkedAt = at
            if (etag != null) this.etag = etag
            if (body != null) this.body = body
        }

        override suspend fun skip(version: String) {
            skipped = version
        }

        override suspend fun clearSkip() {
            skipped = null
        }
    }

    private class FakeDownloader(private val bytes: ByteArray) : ApkDownloader {
        var calls = 0
        var progress = mutableListOf<Long>()

        override suspend fun download(
            url: String,
            target: File,
            expectedBytes: Long,
            expectedSha256: String?,
            onProgress: (Long, Long) -> Unit,
        ): File {
            calls += 1
            target.parentFile?.mkdirs()
            val partial = File(target.parentFile, target.name + ".part")
            partial.writeBytes(bytes)
            partial.renameTo(target)
            progress += bytes.size.toLong()
            onProgress(bytes.size.toLong(), expectedBytes)
            return target
        }
    }

    /** APK とみなせる最小の zip 先頭部。 */
    private fun apkBytes(size: Int = 600 * 1024): ByteArray =
        ByteArray(size) { index -> if (index < 4) byteArrayOf(0x50, 0x4B, 0x03, 0x04)[index] else 0 }

    private fun repository(
        fetcher: FakeFetcher,
        memo: FakeMemo = FakeMemo(),
        downloader: ApkDownloader = FakeDownloader(apkBytes()),
        now: () -> Long = { 1_000_000L },
    ): UpdateRepository = UpdateRepository(
        fetcher = fetcher,
        downloader = downloader,
        memo = memo,
        apkDirectory = temp.newFolder("updates"),
        currentVersionName = "1.1.1",
        currentVersionCode = 3,
        clock = now,
    )

    @Test
    fun `first check offers the newer release and remembers the etag and body`() = runBlocking {
        val fetcher = FakeFetcher { Result.success(ReleaseResponse(releaseJson, "\"etag-1\"")) }
        val memo = FakeMemo()
        val outcome = repository(fetcher, memo).check(manual = false)

        assertTrue(outcome is CheckOutcome.Available)
        val available = outcome as CheckOutcome.Available
        assertEquals("1.1.2", available.info.versionName)
        assertFalse(available.skipped)
        assertEquals("\"etag-1\"", memo.etag)
        assertEquals(releaseJson, memo.body)
        assertNotNull(memo.checkedAt)
    }

    @Test
    fun `a 304 is answered from the remembered document`() = runBlocking {
        val fetcher = FakeFetcher { Result.success(ReleaseResponse(null, "\"etag-1\"", notModified = true)) }
        val memo = FakeMemo().apply {
            etag = "\"etag-1\""
            body = releaseJson
        }
        val outcome = repository(fetcher, memo).check(manual = true)

        assertTrue(outcome is CheckOutcome.Available)
        assertEquals("\"etag-1\"", fetcher.etags.single())
        assertEquals(1, fetcher.calls)
    }

    @Test
    fun `a 304 without a remembered document is not an update`() = runBlocking {
        val fetcher = FakeFetcher { Result.success(ReleaseResponse(null, "\"etag-1\"", notModified = true)) }
        val outcome = repository(fetcher, FakeMemo()).check(manual = true)
        assertTrue(outcome is CheckOutcome.Unavailable)
    }

    @Test
    fun `automatic checks within the debounce window are skipped`() = runBlocking {
        var now = 1_000_000L
        val fetcher = FakeFetcher { Result.success(ReleaseResponse(releaseJson, "\"etag-1\"")) }
        val repository = repository(fetcher, now = { now })

        assertTrue(repository.check(manual = false) is CheckOutcome.Available)
        assertEquals(1, fetcher.calls)

        now += 5_000
        assertEquals(CheckOutcome.Throttled, repository.check(manual = false))
        assertEquals(1, fetcher.calls)

        // 手動はデバウンスを無視して必ず聞く。
        repository.check(manual = true)
        assertEquals(2, fetcher.calls)

        // 20 秒たてば自動でも聞き直す。
        now += UpdateRepository.DEFAULT_AUTO_CHECK_DEBOUNCE_MS
        repository.check(manual = false)
        assertEquals(3, fetcher.calls)
    }

    @Test
    fun `a failure is remembered so resume does not hammer github`() = runBlocking {
        val fetcher = FakeFetcher { Result.failure(java.io.IOException("offline")) }
        val repository = repository(fetcher)
        val outcome = repository.check(manual = false)
        assertTrue(outcome is CheckOutcome.Unavailable)
        assertEquals(1, fetcher.calls)
        assertEquals(CheckOutcome.Throttled, repository.check(manual = false))
        assertEquals(1, fetcher.calls)
    }

    @Test
    fun `up to date when the release is the running version`() = runBlocking {
        val fetcher = FakeFetcher {
            Result.success(
                ReleaseResponse(
                    releaseJson.replace("v1.1.2", "v1.1.1"),
                    "\"etag-1\"",
                ),
            )
        }
        assertEquals(CheckOutcome.UpToDate, repository(fetcher).check(manual = true))
    }

    @Test
    fun `skip hides the version from the banner but keeps it known`() = runBlocking {
        val fetcher = FakeFetcher { Result.success(ReleaseResponse(releaseJson, "\"etag-1\"")) }
        val memo = FakeMemo()
        val repository = repository(fetcher, memo)
        repository.check(manual = true)
        repository.skip("1.1.2")

        val again = repository.check(manual = true) as CheckOutcome.Available
        assertTrue(again.skipped)
        repository.clearSkip()
        val cleared = repository.check(manual = true) as CheckOutcome.Available
        assertFalse(cleared.skipped)
    }

    @Test
    fun `download keeps a valid apk and reuses it`() = runBlocking {
        val bytes = apkBytes()
        val downloader = FakeDownloader(bytes)
        val fetcher = FakeFetcher { Result.success(ReleaseResponse(releaseJson, "\"etag-1\"")) }
        val repository = repository(fetcher, downloader = downloader)
        val info = (repository.check(manual = true) as CheckOutcome.Available).info
        val withSize = info.copy(apkSizeBytes = bytes.size.toLong())

        val first = repository.download(withSize) { _, _ -> }
        assertTrue(first.isSuccess)
        assertEquals(bytes.size.toLong(), first.getOrNull()?.length())
        assertEquals(1, downloader.calls)

        // 2 回目はダウンロードせずに置いてある APK を使う。
        val second = repository.download(withSize) { _, _ -> }
        assertTrue(second.isSuccess)
        assertEquals(1, downloader.calls)
    }

    @Test
    fun `prune removes old apks, part files and unknown junk but keeps the newer apk`() = runBlocking {
        val fetcher = FakeFetcher { Result.failure(java.io.IOException("offline")) }
        val folder = temp.newFolder("updates-prune")
        val repository = UpdateRepository(
            fetcher = fetcher,
            downloader = FakeDownloader(apkBytes()),
            memo = FakeMemo(),
            apkDirectory = folder,
            currentVersionName = "1.1.1",
            currentVersionCode = 3,
            clock = { 10 * 24 * 60 * 60 * 1000L },
        )

        val old = File(folder, "zekey-android-1.1.0.apk").apply { writeBytes(apkBytes()) }
        val current = File(folder, "zekey-android-1.1.1.apk").apply { writeBytes(apkBytes()) }
        val newer = File(folder, "zekey-android-1.1.2.apk").apply { writeBytes(apkBytes()) }
        val part = File(folder, "zekey-android-1.1.2.apk.part").apply { writeText("half") }
        val junk = File(folder, "notes.txt").apply {
            writeText("junk")
            setLastModified(0L)
        }
        val recentJunk = File(folder, "recent.txt").apply {
            writeText("keep for a day")
            setLastModified(10 * 24 * 60 * 60 * 1000L)
        }

        repository.pruneStaleApks()

        assertFalse(old.exists())
        assertFalse("実行中のバージョンの APK も掃除する", current.exists())
        assertTrue("まだ入れていない新しい APK は残す", newer.exists())
        assertFalse(part.exists())
        assertFalse(junk.exists())
        assertTrue(recentJunk.exists())
    }

    @Test
    fun `the download file name is derived from the version`() {
        val fetcher = FakeFetcher { Result.failure(java.io.IOException("offline")) }
        val repository = repository(fetcher)
        val file = repository.apkFileFor(
            UpdateInfo(
                versionName = "1.1.2",
                versionCode = 4,
                notes = "",
                apkUrl = "https://example.com/a.apk",
                apkFileName = "a.apk",
                apkSizeBytes = 1,
                apkSha256 = null,
                releaseUrl = null,
            ),
        )
        assertEquals("zekey-android-1.1.2.apk", file.name)
    }

    @Test
    fun `a cached apk that is not a zip is not reused`() = runBlocking {
        val folder = temp.newFolder("updates-broken")
        val broken = File(folder, "zekey-android-1.1.2.apk").apply { writeText("not a zip at all") }
        val repository = UpdateRepository(
            fetcher = FakeFetcher { Result.failure(java.io.IOException("offline")) },
            downloader = FakeDownloader(apkBytes()),
            memo = FakeMemo(),
            apkDirectory = folder,
            currentVersionName = "1.1.1",
            currentVersionCode = 3,
        )
        val info = UpdateInfo("1.1.2", 4, "", "https://example.com/a.apk", "a.apk", broken.length(), null, null)
        assertNull(repository.cachedApk(info))
    }
}
