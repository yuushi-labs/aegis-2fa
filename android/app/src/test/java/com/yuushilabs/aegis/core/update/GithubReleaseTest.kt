package com.yuushilabs.aegis.core.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** GitHub が実際に返す形のリリース文書から、APK とタグを取り出す。 */
class GithubReleaseTest {

    private val payload = """
        {
          "tag_name": "v1.1.2",
          "name": "Aegis 2FA v1.1.2",
          "body": "## Aegis 2FA v1.1.2\n\n- 同期の http_400 を修正\n\nversionCode: 4\n",
          "html_url": "https://github.com/yuushi-labs/aegis-2fa/releases/tag/v1.1.2",
          "prerelease": false,
          "draft": false,
          "assets": [
            {
              "name": "aegis-php-xserver-v1.1.2.zip",
              "browser_download_url": "https://github.com/yuushi-labs/aegis-2fa/releases/download/v1.1.2/aegis-php-xserver-v1.1.2.zip",
              "size": 734003,
              "content_type": "application/zip"
            },
            {
              "name": "aegis-android-v1.1.2.apk",
              "browser_download_url": "https://github.com/yuushi-labs/aegis-2fa/releases/download/v1.1.2/aegis-android-v1.1.2.apk",
              "size": 8073216,
              "digest": "sha256:3f5c2b9a1d4e6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708",
              "content_type": "application/vnd.android.package-archive"
            }
          ]
        }
    """.trimIndent()

    @Test
    fun `release json is read`() {
        val release = GithubReleaseJson.parse(payload)
        assertEquals("v1.1.2", release?.tagName)
        assertEquals(2, release?.assets?.size)
        assertEquals(false, release?.prerelease)
        val apk = release?.assets?.first { it.name.endsWith(".apk") }
        assertEquals(8_073_216L, apk?.sizeBytes)
        assertEquals("3f5c2b9a1d4e6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708", apk?.sha256)
        assertTrue(apk?.downloadUrl?.startsWith("https://") == true)
    }

    @Test
    fun `the apk in the release becomes the update`() {
        val release = GithubReleaseJson.parse(payload)!!
        val info = UpdateDecision.decide("1.1.1", 3, release)
        assertEquals("1.1.2", info?.versionName)
        assertEquals(4, info?.versionCode)
        assertEquals("aegis-android-v1.1.2.apk", info?.apkFileName)
        assertEquals("https://github.com/yuushi-labs/aegis-2fa/releases/tag/v1.1.2", info?.releaseUrl)
    }

    @Test
    fun `broken documents are ignored`() {
        assertNull(GithubReleaseJson.parse(null))
        assertNull(GithubReleaseJson.parse(""))
        assertNull(GithubReleaseJson.parse("<html>404</html>"))
        assertNull(GithubReleaseJson.parse("""{"message":"Not Found","status":"404"}"""))
        // タグだけの文書は読めても、APK が無いので更新にはならない。
        val tagOnly = GithubReleaseJson.parse("""{"tag_name":"v1.1.2"}""")
        assertNull(UpdateDecision.decide("1.1.1", 3, tagOnly!!))
    }

    @Test
    fun `missing optional fields do not break parsing`() {
        val release = GithubReleaseJson.parse(
            """{"tag_name":"v1.1.2","assets":[{"name":"a.apk","browser_download_url":"https://example.com/a.apk"}]}""",
        )
        assertEquals("v1.1.2", release?.tagName)
        assertEquals(0L, release?.assets?.single()?.sizeBytes)
        assertNull(release?.assets?.single()?.sha256)
    }
}
