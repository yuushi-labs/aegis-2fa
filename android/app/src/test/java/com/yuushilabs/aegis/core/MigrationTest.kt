package com.yuushilabs.aegis.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class MigrationTest {
    private fun varint(value: Long): ByteArray {
        var rest = value
        val out = ArrayList<Byte>()
        while (true) {
            if (rest and 0x7FL.inv() == 0L) {
                out.add(rest.toByte())
                return out.toByteArray()
            }
            out.add(((rest and 0x7f) or 0x80).toByte())
            rest = rest ushr 7
        }
    }

    private fun tag(field: Int, wire: Int): ByteArray = varint((field * 8 + wire).toLong())

    private fun lengthDelimited(field: Int, payload: ByteArray): ByteArray =
        tag(field, 2) + varint(payload.size.toLong()) + payload

    private fun varintField(field: Int, value: Long): ByteArray = tag(field, 0) + varint(value)

    private fun otpParameters(
        secret: ByteArray,
        name: String,
        issuer: String,
        algorithm: Long,
        digits: Long,
        type: Long,
        counter: Long? = null,
    ): ByteArray {
        var bytes = lengthDelimited(1, secret)
        if (name.isNotEmpty()) bytes += lengthDelimited(2, name.toByteArray())
        if (issuer.isNotEmpty()) bytes += lengthDelimited(3, issuer.toByteArray())
        bytes += varintField(4, algorithm)
        bytes += varintField(5, digits)
        bytes += varintField(6, type)
        if (counter != null) bytes += varintField(7, counter)
        return bytes
    }

    private fun payload(entries: List<ByteArray>, batchId: Long = 0L): ByteArray {
        var bytes = ByteArray(0)
        entries.forEach { bytes += lengthDelimited(1, it) }
        bytes += varintField(2, 1)
        bytes += varintField(3, 1)
        bytes += varintField(4, 0)
        bytes += varintField(5, batchId)
        return bytes
    }

    @Test
    fun `decodes totp hotp and skips unknown enums`() {
        val totp = otpParameters("Hello!\u0001".toByteArray(), "GitHub:user", "GitHub", 1, 2, 2)
        val hotp = otpParameters("Hello!\u0001".toByteArray(), "Steam:player", "Steam", 3, 1, 1, counter = 5)
        val unknown = otpParameters("Hello!\u0001".toByteArray(), "Unknown", "X", 9, 1, 2)
        val md5 = otpParameters("Hello!\u0001".toByteArray(), "Old", "Old", 4, 1, 2)
        val result = Migration.decodePayload(payload(listOf(totp, hotp, unknown, md5)))

        assertEquals(2, result.entries.size)
        assertEquals(2, result.skipped)
        assertEquals(1, result.version)
        assertEquals(1, result.batchSize)

        val first = result.entries[0]
        assertEquals("GitHub", first.issuer)
        assertEquals("GitHub:user", first.name)
        assertEquals("SHA1", first.algorithm)
        assertEquals(8, first.digits)
        assertEquals("totp", first.type)
        assertEquals(Base32.encode("Hello!\u0001".toByteArray()), first.secret)

        val second = result.entries[1]
        assertEquals("hotp", second.type)
        assertEquals("SHA512", second.algorithm)
        assertEquals(6, second.digits)
        assertEquals(5L, second.counter)
        assertTrue(result.skipReasons.any { it.contains("不明なアルゴリズム") })
        assertTrue(result.skipReasons.any { it.contains("MD5") })
    }

    @Test
    fun `negative batch id does not fail the import`() {
        val totp = otpParameters("Hello!\u0001".toByteArray(), "GitHub:user", "GitHub", 1, 1, 2)
        val result = Migration.decodePayload(payload(listOf(totp), batchId = -1L))
        assertEquals(-1, result.batchId)
        assertEquals(1, result.entries.size)
    }

    @Test
    fun `bad hotp counter skips only that entry`() {
        val bad = otpParameters("Hello!\u0001".toByteArray(), "Bad", "Bad", 1, 1, 1, counter = -1L)
        val good = otpParameters("Hello!\u0001".toByteArray(), "Good", "Good", 1, 1, 2)
        val result = Migration.decodePayload(payload(listOf(bad, good)))
        assertEquals(1, result.entries.size)
        assertEquals(1, result.skipped)
        assertEquals("Good", result.entries.first().issuer)
    }

    @Test
    fun `parses a migration uri with unpadded base64url`() {
        val entry = otpParameters("Hello!\u0001".toByteArray(), "GitHub:user", "GitHub", 1, 1, 2)
        val encoded = Bytes.base64Url(payload(listOf(entry)))
        val uri = "otpauth-migration://offline?data=$encoded"
        val result = Migration.parseUri(uri)
        assertEquals(1, result.entries.size)
        assertEquals("GitHub:user", result.entries.first().name)
    }

    @Test
    fun `rejects broken migration payloads`() {
        assertThrows(MigrationException::class.java) {
            Migration.parseUri("otpauth-migration://offline")
        }
        assertThrows(MigrationException::class.java) {
            Migration.parseUri("otpauth-migration://offline?data=!!!!")
        }
        assertThrows(MigrationException::class.java) {
            Migration.parseUri("otpauth-migration://offline?data=" + Bytes.base64Url(byteArrayOf(0x3f)))
        }
        assertThrows(MigrationException::class.java) {
            Migration.parseUri("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP")
        }
        // アカウント 0 件（フィールドが無いだけ）はエラー。
        assertThrows(MigrationException::class.java) {
            Migration.parseUri("otpauth-migration://offline?data=" + Bytes.base64Url(payload(emptyList())))
        }
    }

    @Test
    fun `entry to account strips the issuer prefix only once`() {
        val entry = MigrationEntry(
            secret = "JBSWY3DPEHPK3PXP",
            name = "GitHub:yuushi",
            issuer = "GitHub",
            algorithm = "SHA1",
            digits = 6,
            type = "totp",
            counter = 0,
        )
        val account = Migration.entryToAccount(entry, "id-1", "2026-11-21T00:00:00.000Z", 3)
        assertEquals("GitHub", account.issuer)
        assertEquals("yuushi", account.label)
        assertEquals(3, account.order)
        assertEquals("2026-11-21T00:00:00.000Z", account.createdAt)

        val noIssuer = Migration.entryToAccount(entry.copy(issuer = "", name = "GitHub:yuushi"), "id-2", "now", 0)
        assertEquals("GitHub", noIssuer.issuer)
        assertEquals("yuushi", noIssuer.label)
    }

    @Test
    fun `decode of a single entry returns a reason instead of throwing`() {
        val (entry, reason) = Migration.decodeOtpParameters(ByteArray(0))
        assertNull(entry)
        assertNotNull(reason)
    }
}
