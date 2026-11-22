package com.yuushilabs.zekey.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class Base32Test {
    @Test
    fun `encode then decode returns the original bytes`() {
        val bytes = byteArrayOf(0x00, 0x01, 0x7f, 0x80.toByte(), 0xff.toByte(), 0x42)
        assertEquals(bytes.toList(), Base32.decode(Base32.encode(bytes)).toList())
    }

    @Test
    fun `encoding matches RFC 4648 examples`() {
        assertEquals("", Base32.encode(ByteArray(0)))
        assertEquals("MY", Base32.encode("f".toByteArray()))
        assertEquals("MZXQ", Base32.encode("fo".toByteArray()))
        assertEquals("MZXW6", Base32.encode("foo".toByteArray()))
        assertEquals("MZXW6YTBOI", Base32.encode("foobar".toByteArray()))
    }

    @Test
    fun `decoding accepts lowercase spaces and padding`() {
        val expected = Base32.decode("JBSWY3DPEHPK3PXP")
        assertArrayEquals(expected, Base32.decode("jbsw y3dp ehpk 3pxp===="))
        assertArrayEquals(expected, Base32.decode("  JBSWY3DPEHPK3PXP "))
    }

    @Test
    fun `canonical collapses unused bits`() {
        // "MY" と "MZ" はどちらも 1 バイト 0x66（未使用ビットだけが違う）。
        assertEquals(Base32.canonical("MY"), Base32.canonical("MZ"))
    }

    @Test
    fun `percent decoding keeps surrogate pairs`() {
        assertEquals("🔐 Service", Bytes.percentDecode("%F0%9F%94%90%20Service"))
        assertEquals("ゆうし🔑", Bytes.percentDecode("%E3%82%86%E3%81%86%E3%81%97🔑"))
        assertEquals("a b", Bytes.percentDecode("a+b", plusAsSpace = true))
        assertEquals("a+b", Bytes.percentDecode("a+b"))
        // 不完全なユーティリティエンコードは置換文字になる（例外にはしない）。
        assertEquals("\uFFFD", Bytes.percentDecode("%E3"))
    }

    @Test
    fun `invalid characters and lengths are rejected`() {
        assertThrows(Base32.Base32Exception::class.java) { Base32.decode("ABC1") }
        assertThrows(Base32.Base32Exception::class.java) { Base32.decode("A") }
        assertThrows(Base32.Base32Exception::class.java) { Base32.decode("") }
        assertFalse(Base32.isValid("ABC1"))
        assertTrue(Base32.isValid("JBSWY3DPEHPK3PXP"))
    }
}
