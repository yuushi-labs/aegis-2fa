package com.yuushilabs.zekey.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** RFC 4226 / RFC 6238 のテストベクタ。 */
class OtpTest {
    private val asciiDigits = "12345678901234567890"

    @Test
    fun `RFC 4226 HOTP vectors`() {
        val key = asciiDigits.toByteArray()
        val expected = listOf(
            "755224", "287082", "359152", "969429", "338314",
            "254676", "287922", "162583", "399871", "520489",
        )
        expected.forEachIndexed { counter, code ->
            assertEquals("counter=$counter", code, Hotp.generate(key, counter.toLong(), "SHA1", 6))
        }
    }

    @Test
    fun `HOTP accepts Base32 secrets`() {
        val secret = Base32.encode(asciiDigits.toByteArray())
        assertEquals("755224", Hotp.generate(secret, 0, "SHA1", 6))
    }

    @Test
    fun `RFC 6238 TOTP vectors for SHA-1`() {
        val secret = Base32.encode(asciiDigits.toByteArray())
        val vectors = mapOf(
            59L to "94287082",
            1_111_111_109L to "07081804",
            1_111_111_111L to "14050471",
            1_234_567_890L to "89005924",
            2_000_000_000L to "69279037",
            20_000_000_000L to "65353130",
        )
        vectors.forEach { (time, code) ->
            assertEquals("t=$time", code, Totp.generate(secret, time, "SHA1", 8, 30))
        }
    }

    @Test
    fun `RFC 6238 TOTP vectors for SHA-256`() {
        val seed = "12345678901234567890123456789012".toByteArray()
        val secret = Base32.encode(seed)
        val vectors = mapOf(
            59L to "46119246",
            1_111_111_109L to "68084774",
            1_111_111_111L to "67062674",
            1_234_567_890L to "91819424",
            2_000_000_000L to "90698825",
            20_000_000_000L to "77737706",
        )
        vectors.forEach { (time, code) ->
            assertEquals("t=$time", code, Totp.generate(secret, time, "SHA256", 8, 30))
        }
    }

    @Test
    fun `RFC 6238 TOTP vectors for SHA-512`() {
        val seed = ("1234567890123456789012345678901234567890" +
            "123456789012345678901234").toByteArray()
        val secret = Base32.encode(seed)
        val vectors = mapOf(
            59L to "90693936",
            1_111_111_109L to "25091201",
            1_111_111_111L to "99943326",
            1_234_567_890L to "93441116",
            2_000_000_000L to "38618901",
            20_000_000_000L to "47863826",
        )
        vectors.forEach { (time, code) ->
            assertEquals("t=$time", code, Totp.generate(secret, time, "SHA512", 8, 30))
        }
    }

    @Test
    fun `six digit TOTP truncates the eight digit value`() {
        val secret = Base32.encode(asciiDigits.toByteArray())
        assertEquals("287082", Totp.generate(secret, 59, "SHA1", 6, 30))
    }

    @Test
    fun `pair returns current next and remaining`() {
        val secret = Base32.encode(asciiDigits.toByteArray())
        val pair = Totp.pair(secret, 1_111_111_115, period = 30)
        assertEquals(1_111_111_115L / 30, pair.counter)
        assertEquals(25, pair.remaining)
        assertEquals(Totp.generate(secret, 1_111_111_115, "SHA1", 6, 30), pair.current)
        assertEquals(
            Totp.generate(secret, 1_111_111_115 + 30, "SHA1", 6, 30),
            pair.next,
        )
    }

    @Test
    fun `skew shifts the counter within limits`() {
        val secret = Base32.encode(asciiDigits.toByteArray())
        val normal = Totp.pair(secret, 1_000_000_000, period = 30, skew = 0)
        val ahead = Totp.pair(secret, 1_000_000_000, period = 30, skew = 1)
        assertEquals(normal.counter + 1, ahead.counter)
        assertEquals(2, Totp.clampSkew(9))
        assertEquals(-2, Totp.clampSkew(-9))
    }

    @Test
    fun `seconds remaining never returns zero`() {
        assertEquals(30, Totp.secondsRemaining(0, 30))
        assertEquals(1, Totp.secondsRemaining(59, 30))
        assertEquals(30, Totp.secondsRemaining(60, 30))
    }

    @Test
    fun `verify accepts the neighbouring window only`() {
        val secret = Base32.encode(asciiDigits.toByteArray())
        val time = 1_234_567_890L
        val code = Totp.generate(secret, time, "SHA1", 6, 30)
        assertTrue(Totp.verify(secret, code, time))
        assertTrue(Totp.verify(secret, code, time + 30, window = 1))
        assertFalse(Totp.verify(secret, code, time + 120, window = 1))
    }

    @Test
    fun `counter to bytes is big endian`() {
        assertEquals(listOf(0, 0, 0, 0, 0, 0, 0, 1), Hotp.counterToBytes(1).map { it.toInt() and 0xff })
        assertEquals(
            listOf(0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
            Hotp.counterToBytes(Long.MAX_VALUE).map { it.toInt() and 0xff },
        )
    }
}
