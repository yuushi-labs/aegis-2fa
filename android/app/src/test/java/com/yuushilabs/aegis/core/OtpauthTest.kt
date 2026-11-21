package com.yuushilabs.aegis.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class OtpauthTest {
    @Test
    fun `parses a standard totp uri`() {
        val params = Otpauth.parse(
            "otpauth://totp/GitHub:yuushi@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=8&period=60",
        )
        assertEquals("totp", params.type)
        assertEquals("GitHub", params.issuer)
        assertEquals("yuushi@example.com", params.label)
        assertEquals("JBSWY3DPEHPK3PXP", params.secret)
        assertEquals("SHA256", params.algorithm)
        assertEquals(8, params.digits)
        assertEquals(60, params.period)
        assertEquals(0L, params.counter)
    }

    @Test
    fun `query issuer wins over the label prefix`() {
        val params = Otpauth.parse("otpauth://totp/Old:someone?secret=JBSWY3DPEHPK3PXP&issuer=New")
        assertEquals("New", params.issuer)
        assertEquals("someone", params.label)
    }

    @Test
    fun `hotp counter is read`() {
        val params = Otpauth.parse("otpauth://hotp/Steam:user?secret=JBSWY3DPEHPK3PXP&counter=42")
        assertEquals("hotp", params.type)
        assertEquals(42L, params.counter)
        assertEquals(30, params.period)
    }

    @Test
    fun `defaults are applied`() {
        val params = Otpauth.parse("otpauth://totp/example?secret=jbswy3dpehpk3pxp")
        assertEquals("SHA1", params.algorithm)
        assertEquals(6, params.digits)
        assertEquals(30, params.period)
        assertEquals("", params.issuer)
        assertEquals("example", params.label)
    }

    @Test
    fun `percent encoded labels are decoded`() {
        val params = Otpauth.parse(
            "otpauth://totp/My%20Service%3A%E3%82%86%E3%81%86%E3%81%97?secret=JBSWY3DPEHPK3PXP",
        )
        assertEquals("My Service", params.issuer)
        assertEquals("ゆうし", params.label)
    }

    @Test
    fun `round trips through build`() {
        val original = Account(
            type = "totp",
            issuer = "GitHub",
            label = "yuushi@example.com",
            secret = "JBSWY3DPEHPK3PXP",
            algorithm = "SHA512",
            digits = 8,
            period = 45,
        )
        val parsed = Otpauth.parse(Otpauth.build(original))
        assertEquals(original.issuer, parsed.issuer)
        assertEquals(original.label, parsed.label)
        assertEquals(original.secret, parsed.secret)
        assertEquals(original.algorithm, parsed.algorithm)
        assertEquals(original.digits, parsed.digits)
        assertEquals(original.period, parsed.period)
        assertEquals(original.type, parsed.type)
    }

    @Test
    fun `hotp round trip keeps the counter`() {
        val original = Account(type = "hotp", issuer = "Steam", label = "user", secret = "JBSWY3DPEHPK3PXP", counter = 7)
        val parsed = Otpauth.parse(Otpauth.build(original))
        assertEquals(7L, parsed.counter)
    }

    @Test
    fun `invalid uris fail`() {
        assertThrows(OtpauthException::class.java) { Otpauth.parse("https://example.com") }
        assertThrows(OtpauthException::class.java) { Otpauth.parse("otpauth://steam/x?secret=JBSWY3DPEHPK3PXP") }
        assertThrows(OtpauthException::class.java) { Otpauth.parse("otpauth://totp/x") }
        assertThrows(OtpauthException::class.java) { Otpauth.parse("otpauth://totp/x?secret=ABC1") }
        assertThrows(OtpauthException::class.java) {
            Otpauth.parse("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=7")
        }
        assertThrows(OtpauthException::class.java) {
            Otpauth.parse("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=0")
        }
        assertThrows(OtpauthException::class.java) {
            Otpauth.parse("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5")
        }
        assertThrows(OtpauthException::class.java) { Otpauth.parse("otpauth://totp/?secret=JBSWY3DPEHPK3PXP") }
    }

    @Test
    fun `scheme detection`() {
        assertTrue(Otpauth.isOtpauthUri("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP"))
        assertFalse(Otpauth.isOtpauthUri("otpauth-migration://offline?data=x"))
        assertTrue(Otpauth.isMigrationUri("otpauth-migration://offline?data=x"))
    }

    @Test
    fun `encode component leaves unreserved characters`() {
        assertEquals("a-b_c.d!~*'()", Otpauth.encodeComponent("a-b_c.d!~*'()"))
        assertEquals("%E3%81%82%20%3A", Otpauth.encodeComponent("あ :"))
    }
}
