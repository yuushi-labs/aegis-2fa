package com.yuushilabs.aegis.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VaultJsonTest {
    @Test
    fun `round trip keeps every field`() {
        val data = VaultData(
            accounts = listOf(
                Account(
                    id = "id-1",
                    type = "hotp",
                    issuer = "Steam",
                    label = "player",
                    secret = "JBSWY3DPEHPK3PXP",
                    algorithm = "SHA512",
                    digits = 8,
                    period = 60,
                    counter = 12,
                    pinned = true,
                    order = 4,
                    createdAt = "2026-11-21T00:00:00.000Z",
                    updatedAt = "2026-11-21T00:01:00.000Z",
                    notes = "メモ",
                    recoveryCodes = listOf(RecoveryCode("c1", "AAAA", false), RecoveryCode("c2", "BBBB", true)),
                    deletedAt = "2026-11-21T00:02:00.000Z",
                    useCount = 9,
                    lastUsedAt = "2026-11-21T00:03:00.000Z",
                ),
            ),
            tombstones = listOf(Tombstone("dead", "2026-11-20T00:00:00.000Z")),
            devices = listOf(SyncDevice("d1", "Pixel", "Android", "2026-11-21T00:00:00.000Z")),
        )
        val parsed = VaultJson.parse(VaultJson.serialize(data))
        val account = parsed.accounts.single()
        assertEquals("id-1", account.id)
        assertEquals("hotp", account.type)
        assertEquals("SHA512", account.algorithm)
        assertEquals(8, account.digits)
        assertEquals(60, account.period)
        assertEquals(12L, account.counter)
        assertTrue(account.pinned)
        assertEquals(4, account.order)
        assertEquals("メモ", account.notes)
        assertEquals(2, account.recoveryCodes?.size)
        assertTrue(account.recoveryCodes!![1].used)
        assertEquals("2026-11-21T00:02:00.000Z", account.deletedAt)
        assertEquals(9L, account.useCount)
        assertEquals("dead", parsed.tombstones?.single()?.id)
        assertEquals("Pixel", parsed.devices?.single()?.name)
    }

    @Test
    fun `large counters keep full precision`() {
        val parsed = VaultJson.parse("""{"accounts":[{"id":"x","secret":"JBSWY3DPEHPK3PXP","counter":9007199254740993}]}""")
        assertEquals(9_007_199_254_740_993L, parsed.accounts.single().counter)
    }

    @Test
    fun `missing fields fall back to defaults instead of null`() {
        val parsed = VaultJson.parse("""{"accounts":[{"id":"x","secret":"JBSWY3DPEHPK3PXP"}]}""")
        val account = parsed.accounts.single()
        assertEquals("", account.issuer)
        assertEquals("totp", account.type)
        assertEquals("SHA1", account.algorithm)
        assertEquals(6, account.digits)
        assertEquals(30, account.period)
        assertEquals(0L, account.counter)
        assertFalse(account.pinned)
        assertNull(account.notes)
        assertEquals(emptyList<Tombstone>(), parsed.tombstones)
        assertEquals(emptyList<SyncDevice>(), parsed.devices)
    }

    @Test
    fun `broken elements are dropped without failing the whole vault`() {
        val parsed = VaultJson.parse(
            """{"accounts":[{"id":"ok","secret":"JBSWY3DPEHPK3PXP"},{"secret":"no-id"},3],
                "tombstones":[{"id":"t"},{"id":"t2","deletedAt":"x"}],
                "devices":[{"name":"no-id"}],"unknown":{"a":1}}""",
        )
        assertEquals(1, parsed.accounts.size)
        assertEquals(1, parsed.tombstones?.size)
        assertEquals(emptyList<SyncDevice>(), parsed.devices)
    }

    @Test
    fun `invalid json is rejected`() {
        try {
            VaultJson.parse("not json")
            org.junit.Assert.fail("exception expected")
        } catch (_: IllegalArgumentException) {
            // ok
        }
    }

    @Test
    fun `devices are omitted when empty`() {
        val json = VaultJson.serialize(VaultData(emptyList(), emptyList(), null))
        assertFalse(json.contains("devices"))
        assertTrue(json.contains("tombstones"))
    }

    @Test
    fun `manual sort puts pinned first then order`() {
        val sorted = VaultJson.manualSort(
            listOf(
                Account(id = "a", order = 2, createdAt = "2026-01-01"),
                Account(id = "b", pinned = true, order = 9, createdAt = "2026-01-01"),
                Account(id = "c", order = 0, createdAt = "2026-01-02"),
            ),
        )
        assertEquals(listOf("b", "c", "a"), sorted.map { it.id })
    }

    @Test
    fun `next order is max plus one`() {
        assertEquals(0, VaultJson.nextOrder(emptyList()))
        assertEquals(4, VaultJson.nextOrder(listOf(Account(order = 1), Account(order = 3))))
    }

    @Test
    fun `envelope json is read with defaults`() {
        val envelope = Crypto.createEnvelope("correct horse battery staple", "{}")
        val parsed = VaultJson.parseEnvelope(VaultJson.serializeEnvelope(envelope))
        assertEquals(envelope.verifier, parsed?.verifier)
        assertEquals(envelope.revision, parsed?.revision)
        assertEquals(envelope.kdf.iterations, parsed?.kdf?.iterations)
        assertNull(VaultJson.parseEnvelope("{}")?.let { if (Crypto.isEnvelopeShape(it)) it else null })
        assertNull(VaultJson.parseEnvelope("broken"))
    }
}
