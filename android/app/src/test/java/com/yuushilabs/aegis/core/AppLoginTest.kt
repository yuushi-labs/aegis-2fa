package com.yuushilabs.aegis.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLoginTest {
    private val token = "A".repeat(43)
    private val dek = ByteArray(32) { (it + 1).toByte() }

    @Test
    fun `parses the fragment produced by the web app`() {
        val uri = AppLogin.build(token, dek, "メイン")
        val payload = AppLogin.parse(uri)
        assertEquals(token, payload.token)
        assertArrayEquals(dek, payload.dek)
        assertEquals("メイン", payload.vaultName)
    }

    @Test
    fun `code is base64url of the utf8 token`() {
        val uri = AppLogin.build(token, dek, "vault")
        val code = uri.substringAfter("code=").substringBefore("&")
        assertEquals(token, Bytes.fromUtf8(Bytes.base64UrlDecode(code)))
        assertTrue(uri.startsWith("aegis://login#"))
        assertTrue(!uri.substringAfter("#").contains("?"))
    }

    @Test
    fun `name is percent encoded and decoded`() {
        val uri = AppLogin.build(token, dek, "仕事 用 & メモ")
        assertEquals("仕事 用 & メモ", AppLogin.parse(uri).vaultName)
    }

    @Test
    fun `missing attributes are rejected`() {
        assertThrows(AppLoginException::class.java) { AppLogin.parse("aegis://login") }
        assertThrows(AppLoginException::class.java) { AppLogin.parse("aegis://login#") }
        assertThrows(AppLoginException::class.java) {
            AppLogin.parse("aegis://login#dek=" + Bytes.base64Url(dek))
        }
        assertThrows(AppLoginException::class.java) {
            AppLogin.parse("aegis://login#code=" + Bytes.base64Url(Bytes.utf8(token)))
        }
        assertThrows(AppLoginException::class.java) { AppLogin.parse("https://example.com") }
    }

    @Test
    fun `wrong lengths and invalid tokens are rejected`() {
        assertThrows(AppLoginException::class.java) {
            AppLogin.parse("aegis://login#code=${Bytes.base64Url(Bytes.utf8(token))}&dek=${Bytes.base64Url(ByteArray(16))}")
        }
        assertThrows(AppLoginException::class.java) {
            AppLogin.parse("aegis://login#code=${Bytes.base64Url(Bytes.utf8("short"))}&dek=${Bytes.base64Url(dek)}")
        }
    }

    @Test
    fun `link detection`() {
        assertTrue(AppLogin.isAppLoginLink("aegis://login#code=a"))
        assertTrue(!AppLogin.isAppLoginLink("aegis://sync?code=a"))
    }
}
