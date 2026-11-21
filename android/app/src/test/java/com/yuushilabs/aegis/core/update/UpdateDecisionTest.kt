package com.yuushilabs.aegis.core.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** バージョンの比較と、GitHub Releases からの更新判定。 */
class UpdateDecisionTest {

    private fun release(
        tag: String,
        assets: List<ReleaseAsset> = listOf(
            ReleaseAsset(
                name = "aegis-android-$tag.apk",
                downloadUrl = "https://github.com/yuushi-labs/aegis-2fa/releases/download/$tag/aegis-android-$tag.apk",
                sizeBytes = 8_000_000,
            ),
        ),
        body: String? = "## Aegis 2FA $tag\n\nversionCode: 4\n\n- 同期の不具合を修正\n- 一覧の操作を整理\n",
        prerelease: Boolean = false,
        draft: Boolean = false,
    ) = GithubRelease(
        tagName = tag,
        name = "Aegis 2FA $tag",
        body = body,
        prerelease = prerelease,
        draft = draft,
        htmlUrl = "https://github.com/yuushi-labs/aegis-2fa/releases/tag/$tag",
        assets = assets,
    )

    @Test
    fun `parse reads a release tag and compares numerically`() {
        assertTrue(AppVersion.parse("v1.1.2")!! > AppVersion.parse("1.1.1")!!)
        assertEquals(0, AppVersion.parse("v1.1.1")!!.compareTo(AppVersion.parse("1.1.1")!!))
        assertTrue(AppVersion.parse("1.1.10")!! > AppVersion.parse("1.1.9")!!)
        assertTrue(AppVersion.parse("aegis-android-1.2.0")!! > AppVersion.parse("1.1.9")!!)
        assertTrue(AppVersion.parse("1.2.0")!! > AppVersion.parse("1.2.0-beta1")!!)
        assertTrue(AppVersion.parse("1.2.0-beta2")!! > AppVersion.parse("1.2.0-beta1")!!)
        assertTrue(AppVersion.parse("1.2.0-beta10")!! > AppVersion.parse("1.2.0-beta2")!!)
        assertNull("日付やビルド番号はバージョンではない", AppVersion.parse("2026-11-21"))
        assertNull(AppVersion.parse("build-12"))
        assertEquals("1.1.2", AppVersion.parse("v1.1.2")!!.display)
    }

    @Test
    fun `newer release is offered`() {
        val info = UpdateDecision.decide("1.1.1", 3, release("v1.1.2"))
        assertEquals("1.1.2", info?.versionName)
        assertEquals(4, info?.versionCode)
        assertEquals("aegis-android-v1.1.2.apk", info?.apkFileName)
        assertEquals(8_000_000L, info?.apkSizeBytes)
        assertTrue(info?.notes.orEmpty().contains("同期の不具合"))
        assertFalse("versionCode の行は要約に出さない", info?.notes.orEmpty().contains("versionCode"))
    }

    @Test
    fun `same or older release is not offered`() {
        assertNull(UpdateDecision.decide("1.1.1", 3, release("v1.1.1")))
        assertNull(UpdateDecision.decide("1.1.1", 3, release("v1.1.0")))
    }

    @Test
    fun `prerelease and draft are never offered`() {
        assertNull(UpdateDecision.decide("1.1.1", 3, release("v1.2.0", prerelease = true)))
        assertNull(UpdateDecision.decide("1.1.1", 3, release("v1.2.0", draft = true)))
    }

    @Test
    fun `a release without an apk is not offered`() {
        assertNull(
            UpdateDecision.decide(
                "1.1.1",
                3,
                release("v1.1.2", assets = listOf(ReleaseAsset("aegis-php-xserver-v1.1.2.zip", "https://example.com/a.zip", 2_000_000))),
            ),
        )
    }

    @Test
    fun `a tiny apk is treated as a broken asset`() {
        assertNull(
            UpdateDecision.decide(
                "1.1.1",
                3,
                release("v1.1.2", assets = listOf(ReleaseAsset("aegis-android-v1.1.2.apk", "https://example.com/a.apk", 1_024))),
            ),
        )
    }

    @Test
    fun `the aegis apk is picked when the release holds several apks`() {
        val info = UpdateDecision.decide(
            "1.1.1",
            3,
            release(
                "v1.1.2",
                assets = listOf(
                    ReleaseAsset("debug-other.apk", "https://example.com/other.apk", 9_000_000),
                    ReleaseAsset("aegis-android-v1.1.2.apk", "https://example.com/aegis.apk", 8_000_000, sha256 = "abc123"),
                ),
            ),
        )
        assertEquals("aegis-android-v1.1.2.apk", info?.apkFileName)
        assertEquals("abc123", info?.apkSha256)
    }

    @Test
    fun `a release without a parsable tag falls back to the declared versionCode`() {
        val info = UpdateDecision.decide(
            currentVersionName = "1.1.1",
            currentVersionCode = 3,
            release = GithubRelease(
                tagName = "aegis-build",
                name = null,
                body = "versionCode=7\n\n- 修正",
                prerelease = false,
                draft = false,
                htmlUrl = null,
                assets = listOf(ReleaseAsset("aegis-android.apk", "https://example.com/a.apk", 8_000_000)),
            ),
        )
        assertEquals(7, info?.versionCode)
        assertNull(UpdateDecision.decide("1.1.1", 3, release("v1.1.1").copy(body = "versionCode=3")))
    }
}
