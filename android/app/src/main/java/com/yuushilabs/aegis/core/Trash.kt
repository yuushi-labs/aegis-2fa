package com.yuushilabs.aegis.core

/**
 * ゴミ箱（30 日で完全削除）。Web 版 `shared/trash.ts` と同じ規則。
 *
 * 1. ゴミ箱へ移動: `deletedAt` に時刻を入れるだけ（tombstone は作らない＝他端末にも同期される）
 * 2. 完全削除: アカウントを取り除き tombstone に記録する（別端末からの復活を防ぐ）
 */
object Trash {
    const val RETENTION_DAYS = 30
    private const val DAY_MS = 24L * 60L * 60L * 1000L
    const val RETENTION_MS = RETENTION_DAYS * DAY_MS

    fun isTrashed(account: Account): Boolean = !account.deletedAt.isNullOrEmpty()

    /** 完全削除される時刻（ミリ秒）。ゴミ箱でなければ・日時が壊れていれば null。 */
    fun expiresAt(account: Account): Long? {
        if (!isTrashed(account)) return null
        val deleted = IsoTime.parseOrNull(account.deletedAt) ?: return null
        return deleted + RETENTION_MS
    }

    /** 自動完全削除までの残り日数（切り上げ。今日中なら 1。判定不能なら 0）。 */
    fun remainingDays(account: Account, now: Long = System.currentTimeMillis()): Int {
        val expires = expiresAt(account) ?: return 0
        val remaining = expires - now
        if (remaining <= 0) return 0
        val days = ((remaining + DAY_MS - 1) / DAY_MS).toInt()
        return minOf(RETENTION_DAYS, days)
    }

    fun isExpired(account: Account, now: Long = System.currentTimeMillis()): Boolean {
        val expires = expiresAt(account) ?: return false
        return now >= expires
    }

    data class Split(val active: List<Account>, val trashed: List<Account>, val expired: List<Account>)

    fun split(accounts: List<Account>, now: Long = System.currentTimeMillis()): Split {
        val active = ArrayList<Account>()
        val trashed = ArrayList<Account>()
        val expired = ArrayList<Account>()
        for (account in accounts) {
            when {
                !isTrashed(account) -> active.add(account)
                isExpired(account, now) -> expired.add(account)
                else -> trashed.add(account)
            }
        }
        return Split(active, trashed, expired)
    }

    data class Purged(val accounts: List<Account>, val tombstones: List<Tombstone>, val purged: Int)

    /** 期限切れのゴミ箱を完全削除し、tombstone に記録する。 */
    fun purgeExpired(
        accounts: List<Account>,
        tombstones: List<Tombstone>,
        now: Long = System.currentTimeMillis(),
    ): Purged {
        val kept = ArrayList<Account>(accounts.size)
        val added = ArrayList<Tombstone>()
        for (account in accounts) {
            if (isExpired(account, now)) {
                added.add(Tombstone(account.id, account.deletedAt.orEmpty()))
            } else {
                kept.add(account)
            }
        }
        if (added.isEmpty()) return Purged(accounts, tombstones, 0)
        return Purged(kept, VaultMerge.mergeTombstones(tombstones, added), added.size)
    }
}
