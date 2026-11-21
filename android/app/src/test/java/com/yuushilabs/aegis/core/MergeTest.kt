package com.yuushilabs.aegis.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MergeTest {
    private fun account(
        id: String,
        updatedAt: String,
        label: String = "user",
        pinned: Boolean = false,
        order: Int = 0,
        deletedAt: String? = null,
    ) = Account(
        id = id,
        issuer = "Service",
        label = label,
        secret = "JBSWY3DPEHPK3PXP",
        createdAt = "2026-01-01T00:00:00.000Z",
        updatedAt = updatedAt,
        pinned = pinned,
        order = order,
        deletedAt = deletedAt,
    )

    @Test
    fun `newer updatedAt wins per id`() {
        val base = VaultData(listOf(account("a", "2026-11-20T00:00:00.000Z", label = "old")), emptyList())
        val incoming = VaultData(listOf(account("a", "2026-11-21T00:00:00.000Z", label = "new")), emptyList())
        val result = VaultMerge.merge(base, incoming, now = 0)
        assertEquals("new", result.data.accounts.single().label)
        assertEquals(1, result.updated)
        assertEquals(0, result.added)
    }

    @Test
    fun `older incoming content does not overwrite`() {
        val base = VaultData(listOf(account("a", "2026-11-21T00:00:00.000Z", label = "new")), emptyList())
        val incoming = VaultData(listOf(account("a", "2026-11-20T00:00:00.000Z", label = "old")), emptyList())
        val result = VaultMerge.merge(base, incoming, now = 0)
        assertEquals("new", result.data.accounts.single().label)
        assertEquals(1, result.overwritten)
    }

    @Test
    fun `same timestamp resolves by stable content comparison regardless of order`() {
        val left = account("a", "2026-11-21T00:00:00.000Z", label = "alpha")
        val right = account("a", "2026-11-21T00:00:00.000Z", label = "beta")
        val forward = VaultMerge.merge(VaultData(listOf(left), emptyList()), VaultData(listOf(right), emptyList()), now = 0)
        val backward = VaultMerge.merge(VaultData(listOf(right), emptyList()), VaultData(listOf(left), emptyList()), now = 0)
        assertEquals(forward.data.accounts.single().label, backward.data.accounts.single().label)
    }

    @Test
    fun `tombstone removes an account and prevents resurrection`() {
        val base = VaultData(listOf(account("a", "2026-11-20T00:00:00.000Z")), emptyList())
        val incoming = VaultData(
            accounts = listOf(account("a", "2026-11-20T00:00:00.000Z")),
            tombstones = listOf(Tombstone("a", "2026-11-21T00:00:00.000Z")),
        )
        val result = VaultMerge.merge(base, incoming, now = 0)
        assertTrue(result.data.accounts.isEmpty())
        assertEquals(1, result.data.tombstones?.size)
    }

    @Test
    fun `recreated account with newer updatedAt survives a tombstone`() {
        val incoming = VaultData(
            accounts = listOf(account("a", "2026-11-22T00:00:00.000Z", label = "recreated")),
            tombstones = listOf(Tombstone("a", "2026-11-21T00:00:00.000Z")),
        )
        val result = VaultMerge.merge(VaultData(emptyList(), emptyList()), incoming, now = 0)
        assertEquals("recreated", result.data.accounts.single().label)
    }

    @Test
    fun `tombstones are merged by newest deletedAt`() {
        val merged = VaultMerge.mergeTombstones(
            listOf(Tombstone("a", "2026-11-20T00:00:00.000Z"), Tombstone("b", "2026-11-19T00:00:00.000Z")),
            listOf(Tombstone("a", "2026-11-21T00:00:00.000Z")),
        )
        assertEquals(2, merged.size)
        assertEquals("2026-11-21T00:00:00.000Z", merged.first { it.id == "a" }.deletedAt)
    }

    @Test
    fun `devices keep the newest lastSyncedAt`() {
        val base = VaultData(emptyList(), emptyList(), listOf(SyncDevice("d1", "old", "Android", "2026-11-20T00:00:00.000Z")))
        val incoming = VaultData(emptyList(), emptyList(), listOf(SyncDevice("d1", "new", "Android", "2026-11-21T00:00:00.000Z")))
        val result = VaultMerge.merge(base, incoming, now = 0)
        assertEquals("new", result.data.devices?.single()?.name)
        assertEquals("d1", result.data.devices?.single()?.id)
    }

    @Test
    fun `expired trash is purged before merging`() {
        val old = "2026-01-01T00:00:00.000Z"
        val trashed = account("a", old, deletedAt = old)
        val now = IsoTime.parseOrNull("2026-11-21T00:00:00.000Z")!!
        val result = VaultMerge.merge(VaultData(listOf(trashed), emptyList()), VaultData(emptyList(), emptyList()), now = now)
        assertTrue(result.data.accounts.isEmpty())
        assertEquals("a", result.data.tombstones?.single()?.id)
        assertEquals(1, result.deleted)
    }

    @Test
    fun `pinned accounts sort first and order is respected`() {
        val base = VaultData(
            listOf(
                account("a", "2026-11-20T00:00:00.000Z", order = 1),
                account("b", "2026-11-20T00:00:00.000Z", pinned = true, order = 5),
                account("c", "2026-11-20T00:00:00.000Z", order = 0),
            ),
            emptyList(),
        )
        val result = VaultMerge.merge(base, VaultData(emptyList(), emptyList()), now = 0)
        assertEquals(listOf("b", "c", "a"), result.data.accounts.map { it.id })
    }

    @Test
    fun `unparseable timestamps have a fixed order so merges are associative`() {
        val a = account("a", "2026-11-21T00:00:00.000Z", label = "A")
        val b = account("a", "2026-11-21T01:00:00.000+02:00", label = "B")
        val c = account("a", "2026-11-21T00:30:00.invalid", label = "C")
        val left = VaultMerge.merge(
            VaultMerge.merge(VaultData(listOf(a), emptyList()), VaultData(listOf(b), emptyList()), now = 0).data,
            VaultData(listOf(c), emptyList()),
            now = 0,
        )
        val right = VaultMerge.merge(
            VaultData(listOf(a), emptyList()),
            VaultMerge.merge(VaultData(listOf(b), emptyList()), VaultData(listOf(c), emptyList()), now = 0).data,
            now = 0,
        )
        // A（11-21 00:00Z）が最も新しく、B は前日 23:00Z。壊れた日時は常に古い側。
        assertEquals("A", left.data.accounts.single().label)
        assertEquals(left.data.accounts.single().label, right.data.accounts.single().label)
    }

    @Test
    fun `duplicate ids on the base side keep the newest version`() {
        val older = account("a", "2026-11-20T00:00:00.000Z", label = "old")
        val newer = account("a", "2026-11-21T00:00:00.000Z", label = "new")
        val result = VaultMerge.merge(
            VaultData(listOf(newer, older), emptyList()),
            VaultData(listOf(newer), emptyList()),
            now = 0,
        )
        assertEquals("new", result.data.accounts.single().label)
        val reversed = VaultMerge.merge(
            VaultData(listOf(older, newer), emptyList()),
            VaultData(listOf(newer), emptyList()),
            now = 0,
        )
        assertEquals("new", reversed.data.accounts.single().label)
    }

    @Test
    fun `canonical json escapes control characters like JSON stringify`() {
        val json = com.google.gson.JsonParser.parseString("""{"a":"x\u0001\b\f\n\t\"y"}""")
        assertEquals("""{"a":"x\u0001\b\f\n\t\"y"}""", VaultMerge.canonicalJson(json))
    }

    @Test
    fun `canonical json ignores key order`() {
        val a = com.google.gson.JsonParser.parseString("""{"b":1,"a":[1,2]}""")
        val b = com.google.gson.JsonParser.parseString("""{"a":[1,2],"b":1}""")
        assertEquals(VaultMerge.canonicalJson(a), VaultMerge.canonicalJson(b))
    }

    @Test
    fun `passkey infos are merged by id and deletions stay deleted`() {
        val merged = VaultMerge.mergePasskeyInfos(
            listOf(
                PasskeyInfo("k1", "Pixel", "2026-01-01T00:00:00.000Z", "phone", "Pixel"),
                PasskeyInfo("k2", "YubiKey", "2026-01-01T00:00:00.000Z", "pc", "PC", "2026-03-01T00:00:00.000Z"),
            ),
            listOf(
                PasskeyInfo("k1", "Pixel 8", "2026-02-01T00:00:00.000Z", "phone", "Pixel"),
                PasskeyInfo("k2", "YubiKey", "2026-01-01T00:00:00.000Z", "pc", "PC"),
            ),
        )
        assertEquals(listOf("k1", "k2"), merged.map { it.id })
        assertEquals("Pixel 8", merged[0].name)
        // 削除の印は取り消さない（古い端末の情報で復活させない）。
        assertEquals("2026-03-01T00:00:00.000Z", merged[1].deletedAt)
    }

    @Test
    fun `passkey device name ties resolve the same way regardless of order`() {
        val a = listOf(PasskeyInfo("k1", "Pixel", "2026-01-01T00:00:00.000Z", "phone", "Pixel"))
        val b = listOf(PasskeyInfo("k1", "Pixel", "2026-01-01T00:00:00.000Z", "phone", "Pixel 8"))
        assertEquals(VaultMerge.mergePasskeyInfos(a, b), VaultMerge.mergePasskeyInfos(b, a))
        assertEquals("Pixel 8", VaultMerge.mergePasskeyInfos(a, b).single().deviceName)
    }

    @Test
    fun `merging vault data keeps passkey infos`() {
        val base = VaultData(
            accounts = emptyList(),
            passkeyInfos = listOf(PasskeyInfo("k1", "Pixel", "2026-01-01T00:00:00.000Z", "phone")),
        )
        val incoming = VaultData(
            accounts = listOf(account("a", "2026-01-02T00:00:00.000Z")),
            passkeyInfos = listOf(PasskeyInfo("k2", "Mac", "2026-01-02T00:00:00.000Z", "mac")),
        )
        val result = VaultMerge.merge(base, incoming, now = 0)
        assertEquals(listOf("k1", "k2"), result.data.passkeyInfos?.map { it.id })
        assertEquals(1, result.added)
    }
}
