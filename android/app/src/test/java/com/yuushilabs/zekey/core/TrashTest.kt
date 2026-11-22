package com.yuushilabs.zekey.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TrashTest {
    private val now = IsoTime.parseOrNull("2026-11-21T00:00:00.000Z")!!

    private fun trashed(deletedAt: String?) = Account(
        id = "a",
        issuer = "S",
        label = "l",
        secret = "JBSWY3DPEHPK3PXP",
        createdAt = "2026-01-01T00:00:00.000Z",
        updatedAt = "2026-01-01T00:00:00.000Z",
        deletedAt = deletedAt,
    )

    @Test
    fun `not trashed accounts never expire`() {
        assertNull(Trash.expiresAt(trashed(null)))
        assertFalse(Trash.isExpired(trashed(null), now))
        assertEquals(0, Trash.remainingDays(trashed(null), now))
    }

    @Test
    fun `just under 30 days is still restorable`() {
        val account = trashed("2026-11-20T23:00:00.000Z")
        assertFalse(Trash.isExpired(account, now))
        assertEquals(30, Trash.remainingDays(account, now))
    }

    @Test
    fun `29 days elapsed leaves one day`() {
        val account = trashed("2026-10-22T00:30:00.000Z")
        assertFalse(Trash.isExpired(account, now))
        assertEquals(1, Trash.remainingDays(account, now))
    }

    @Test
    fun `30 days is expired`() {
        val account = trashed("2026-10-22T00:00:00.000Z")
        assertTrue(Trash.isExpired(account, now))
        assertEquals(0, Trash.remainingDays(account, now))
    }

    @Test
    fun `remaining days round up`() {
        val account = trashed("2026-11-20T12:00:00.000Z")
        assertEquals(30, Trash.remainingDays(account, now))
    }

    @Test
    fun `broken dates are never treated as expired`() {
        val account = trashed("not a date")
        assertNull(Trash.expiresAt(account))
        assertFalse(Trash.isExpired(account, now))
        assertEquals(0, Trash.remainingDays(account, now))
    }

    @Test
    fun `purge removes expired accounts and records tombstones`() {
        val expired = trashed("2026-10-01T00:00:00.000Z")
        val alive = trashed("2026-11-20T00:00:00.000Z")
        val result = Trash.purgeExpired(listOf(expired, alive), emptyList(), now)
        assertEquals(1, result.purged)
        assertEquals(listOf("a"), result.accounts.map { it.id })
        assertEquals("2026-10-01T00:00:00.000Z", result.tombstones.single().deletedAt)
    }

    @Test
    fun `split separates active trashed and expired`() {
        val split = Trash.split(
            listOf(
                trashed(null),
                trashed("2026-11-20T00:00:00.000Z"),
                trashed("2026-10-01T00:00:00.000Z"),
            ),
            now,
        )
        assertEquals(1, split.active.size)
        assertEquals(1, split.trashed.size)
        assertEquals(1, split.expired.size)
    }
}

class DuplicatesTest {
    private fun account(label: String, secret: String = "JBSWY3DPEHPK3PXP", deletedAt: String? = null) = Account(
        id = label,
        issuer = "GitHub",
        label = label,
        secret = secret,
        deletedAt = deletedAt,
    )

    @Test
    fun `same secret with different case is a duplicate`() {
        val matches = Duplicates.findDuplicates(
            listOf(account("a", secret = "JBSWY3DPEHPK3PXP")),
            account("b", secret = "jbswy3dpehpk3pxp"),
        )
        assertEquals(1, matches.size)
        assertEquals(listOf(DuplicateReason.SECRET), matches.single().reasons)
    }

    @Test
    fun `same issuer and label ignoring case and spaces is a duplicate`() {
        val existing = listOf(account(" User@Example.com "))
        val matches = Duplicates.findDuplicates(existing, account("user@example.com", secret = "MFRGGZDFMZTWQ2LK"))
        assertEquals(1, matches.size)
        assertEquals(listOf(DuplicateReason.LABEL), matches.single().reasons)
    }

    @Test
    fun `both reasons can match`() {
        val matches = Duplicates.findDuplicates(listOf(account("user")), account("USER"))
        assertEquals(listOf(DuplicateReason.SECRET, DuplicateReason.LABEL), matches.single().reasons)
    }

    @Test
    fun `trashed accounts are not duplicates`() {
        val existing = listOf(account("user", deletedAt = "2026-11-20T00:00:00.000Z"))
        assertTrue(Duplicates.findDuplicates(existing, account("user")).isEmpty())
    }

    @Test
    fun `different accounts are not duplicates`() {
        val existing = listOf(account("user", secret = "JBSWY3DPEHPK3PXP"))
        assertTrue(Duplicates.findDuplicates(existing, account("other", secret = "MFRGGZDFMZTWQ2LK")).isEmpty())
    }
}
