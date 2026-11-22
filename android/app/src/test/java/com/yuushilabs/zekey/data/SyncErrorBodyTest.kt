package com.yuushilabs.zekey.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * サーバーが返すエラー本文の読み取り。`http_400` のような生のコードを画面に出さず、
 * 日本語のメッセージと、設定の「詳細」用のコードに分ける。
 *
 * 本文の形は Node 版 `server/routes/vault.ts` と PHP 版 `Application.php` の
 * `Response::error($code, $status, ['issues' => ...])` に合わせている。
 */
class SyncErrorBodyTest {

    @Test
    fun `revision_must_advance is understood`() {
        val failure = SyncErrors.fromBody(400, """{"error":"revision_must_advance"}""")
        assertEquals("revision_must_advance", failure.code)
        assertEquals(400, failure.status)
        assertTrue(failure.message.contains("もう一度同期"))
        assertFalse(failure.message.contains("http"))
        assertEquals("http_400 revision_must_advance", failure.debugLabel)
    }

    @Test
    fun `invalid_body keeps the field issues for debugging`() {
        val failure = SyncErrors.fromBody(
            400,
            """{"error":"invalid_body","issues":["envelope.data.ciphertext","envelope.revision"]}""",
        )
        assertEquals("invalid_body", failure.code)
        assertEquals(listOf("envelope.data.ciphertext", "envelope.revision"), failure.issues)
        assertTrue(failure.message.contains("アプリを最新版"))
        assertEquals("http_400 invalid_body envelope.data.ciphertext,envelope.revision", failure.debugLabel)
    }

    @Test
    fun `a missing or broken body still maps by status`() {
        assertEquals("not_found", SyncErrors.fromBody(404, "").code)
        assertEquals("not_found", SyncErrors.fromBody(404, "<html>Not Found</html>").code)
        assertEquals("server", SyncErrors.fromBody(500, "").code)
        assertEquals("unauthorized", SyncErrors.fromBody(401, """{"error":"unauthorized"}""").code)
        assertEquals("too_large", SyncErrors.fromBody(413, "").code)
        assertEquals("rate_limited", SyncErrors.fromBody(429, "").code)
        assertTrue(SyncErrors.fromBody(429, "").message.contains("少し待って"))
    }

    @Test
    fun `response error is turned into a sync exception with the server code`() {
        val error = try {
            throw SyncHttpException(400, "invalid_vault_id")
        } catch (caught: SyncHttpException) {
            caught
        }
        val failure = SyncFailure.of(error)
        assertEquals("invalid_body", failure.code)
        assertEquals("invalid_vault_id", failure.serverCode)
        assertEquals("http_400 invalid_vault_id", failure.debugLabel)
    }
}
