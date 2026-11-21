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
    fun `canonical json ignores key order`() {
        val a = com.google.gson.JsonParser.parseString("""{"b":1,"a":[1,2]}""")
        val b = com.google.gson.JsonParser.parseString("""{"a":[1,2],"b":1}""")
        assertEquals(VaultMerge.canonicalJson(a), VaultMerge.canonicalJson(b))
    }
}
