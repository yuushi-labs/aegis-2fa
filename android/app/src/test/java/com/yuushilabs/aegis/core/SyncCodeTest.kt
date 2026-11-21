package com.yuushilabs.aegis.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncCodeTest {
    @Test
    fun `generated token is 43 base64url characters`() {
        val token = SyncCode.generateToken()
        assertEquals(43, token.length)
        assertTrue(SyncCode.isValidToken(token))
        assertTrue(token.all { it.isLetterOrDigit() || it == '-' || it == '_' })
    }

    @Test
    fun `token validation matches the web rules`() {
        assertFalse(SyncCode.isValidToken(""))
        assertFalse(SyncCode.isValidToken("A".repeat(43) + "!"))
        assertFalse(SyncCode.isValidToken("A".repeat(39)))
        // 40 文字は 30 バイトにしかならず、32 バイト（43 文字）ではない。
        assertFalse(SyncCode.isValidToken("A".repeat(40)))
        assertTrue(SyncCode.isValidToken("A".repeat(43)))
        assertFalse(SyncCode.isValidToken("A".repeat(44)))
    }

    @Test
    fun `vault id is the first 32 hex chars of sha256`() {
        val token = "A".repeat(43)
        assertEquals(Bytes.sha256Hex(token).take(32), SyncCode.deriveVaultId(token))
        assertEquals(32, SyncCode.deriveVaultId(token).length)
        assertTrue(SyncCode.isValidVaultId(SyncCode.deriveVaultId(token)))
        assertEquals(64, SyncCode.deriveTokenHash(token).length)
    }

    @Test
    fun `format groups by four characters`() {
        val token = "abcdefghij"
        assertEquals("abcd efgh ij", SyncCode.format(token))
        assertEquals(token, SyncCode.normalize("abcd efgh ij"))
        assertEquals(token, SyncCode.normalize("abcd\nefgh\tij"))
    }

    @Test
    fun `extracts the token from pasted input`() {
        val token = SyncCode.generateToken()
        assertEquals(token, SyncCode.extract(token))
        assertEquals(token, SyncCode.extract(SyncCode.format(token)))
        assertEquals(token, SyncCode.extract("https://yuushi0911.xsrv.jp/aegis/sync?code=$token"))
        assertEquals(token, SyncCode.extract("https://yuushi0911.xsrv.jp/aegis/?sync=$token"))
        assertEquals(token, SyncCode.extract("https://yuushi0911.xsrv.jp/aegis/#sync=$token"))
        assertEquals(token, SyncCode.extract("/sync/$token"))
        assertEquals(token, SyncCode.extract("aegis://sync?code=$token"))
        assertEquals(token, SyncCode.extract("aegis://sync#$token"))
    }

    @Test
    fun `rejects values that are not sync codes`() {
        assertEquals(null, SyncCode.extract(""))
        assertEquals(null, SyncCode.extract("hello"))
        assertEquals(null, SyncCode.extract("https://example.com/path"))
        assertEquals(null, SyncCode.extract("https://example.com/sync?code=short"))
    }
}
