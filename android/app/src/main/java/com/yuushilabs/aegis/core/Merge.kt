package com.yuushilabs.aegis.core

import com.google.gson.JsonElement
import com.google.gson.JsonObject

/**
 * 同期の競合解決: アカウント id 単位の union。Web 版 `shared/merge.ts` と意味を揃える。
 *
 * - 同一 id は `updatedAt` が新しい方を採る。同時刻なら内容の安定比較で決める（入力順に依存しない）。
 * - 削除は tombstone（id + deletedAt）で表し、`deletedAt >= updatedAt` のアカウントは結果から除く。
 * - ゴミ箱に 30 日以上置かれたものはマージ前に完全削除へ進める。
 */
data class MergeResult(
    val data: VaultData,
    val added: Int,
    val updated: Int,
    val overwritten: Int,
    val deleted: Int,
)

object VaultMerge {
    fun compareAccountContent(a: Account, b: Account): Int {
        val left = canonicalJson(VaultJson.gson.toJsonTree(a))
        val right = canonicalJson(VaultJson.gson.toJsonTree(b))
        return left.compareTo(right)
    }

    /**
     * 日時の全順序。解析できる日時は時刻で比べ、解析できない日時は
     * **常に古い側**として扱う（同じ規則を isNewer と tombstone 比較で使う）。
     * 規則を混ぜると比較が循環し、マージの順序で結果が変わってしまう。
     */
    private fun compareTimestamps(a: String, b: String): Int {
        val ta = IsoTime.parseOrNull(a)
        val tb = IsoTime.parseOrNull(b)
        return when {
            ta != null && tb != null -> ta.compareTo(tb)
            ta != null -> 1
            tb != null -> -1
            else -> a.compareTo(b)
        }
    }

    private fun isNewer(candidate: Account, current: Account): Boolean {
        val byTime = compareTimestamps(candidate.updatedAt, current.updatedAt)
        if (byTime != 0) return byTime > 0
        return compareAccountContent(candidate, current) > 0
    }

    fun mergeTombstones(vararg lists: List<Tombstone>?): List<Tombstone> {
        val byId = LinkedHashMap<String, Tombstone>()
        for (list in lists) {
            for (tombstone in list.orEmpty()) {
                val current = byId[tombstone.id]
                if (current == null || compareTimestamps(tombstone.deletedAt, current.deletedAt) > 0) {
                    byId[tombstone.id] = tombstone
                }
            }
        }
        return byId.values.sortedBy { it.id }
    }

    private fun isDeleted(account: Account, tombstones: Map<String, Tombstone>): Boolean {
        val tombstone = tombstones[account.id] ?: return false
        return compareTimestamps(tombstone.deletedAt, account.updatedAt) >= 0
    }

    fun mergeDevices(vararg lists: List<SyncDevice>?): List<SyncDevice> {
        val byId = LinkedHashMap<String, SyncDevice>()
        for (list in lists) {
            for (device in list.orEmpty()) {
                if (device.id.isEmpty()) continue
                val current = byId[device.id]
                if (current == null || compareTimestamps(device.lastSyncedAt, current.lastSyncedAt) > 0) {
                    byId[device.id] = device.copy(
                        name = device.name.ifEmpty { "Device" },
                    )
                }
            }
        }
        return byId.values.sortedBy { it.id }
    }

    fun merge(
        base: VaultData,
        incoming: VaultData,
        now: Long = System.currentTimeMillis(),
    ): MergeResult {
        val purgedBase = Trash.purgeExpired(base.accounts, base.tombstones.orEmpty(), now)
        val purgedIncoming = Trash.purgeExpired(incoming.accounts, incoming.tombstones.orEmpty(), now)
        val tombstones = mergeTombstones(purgedBase.tombstones, purgedIncoming.tombstones)
        val tombstoneIndex = tombstones.associateBy { it.id }

        val baseAccounts = purgedBase.accounts.filter { !isDeleted(it, tombstoneIndex) }
        val incomingAccounts = purgedIncoming.accounts.filter { !isDeleted(it, tombstoneIndex) }

        val baseIds = base.accounts.map { it.id }.toSet()
        val byId = LinkedHashMap<String, Account>()
        // base 側に同じ id が複数あっても、新しい方を残す（incoming 側と同じ規則）。
        for (account in baseAccounts) {
            val current = byId[account.id]
            if (current == null || isNewer(account, current)) byId[account.id] = account
        }

        var added = 0
        var updated = 0
        var overwritten = 0

        for (candidate in incomingAccounts) {
            val current = byId[candidate.id]
            if (current == null) {
                byId[candidate.id] = candidate
                if (candidate.id in baseIds) updated += 1 else added += 1
            } else if (compareAccountContent(candidate, current) == 0) {
                continue
            } else if (isNewer(candidate, current)) {
                byId[candidate.id] = candidate
                updated += 1
            } else {
                overwritten += 1
            }
        }

        val deleted = (base.accounts.size - baseAccounts.size) +
            purgedIncoming.accounts.count { isDeleted(it, tombstoneIndex) && it.id !in baseIds }

        val accounts = VaultJson.manualSort(byId.values.toList())
        val devices = mergeDevices(base.devices, incoming.devices)
        return MergeResult(
            data = VaultData(
                accounts = accounts,
                tombstones = tombstones,
                devices = if (devices.isEmpty()) null else devices,
            ),
            added = added,
            updated = updated,
            overwritten = overwritten,
            deleted = deleted,
        )
    }

    /** キー順を固定した JSON（内容比較用）。 */
    fun canonicalJson(element: JsonElement): String = when {
        element.isJsonNull -> "null"
        element.isJsonPrimitive -> element.asJsonPrimitive.let { primitive ->
            if (primitive.isString) "\"${escape(primitive.asString)}\"" else primitive.asString
        }
        element.isJsonArray -> {
            val array = element.asJsonArray
            (0 until array.size()).joinToString(prefix = "[", postfix = "]") { canonicalJson(array[it]) }
        }
        else -> {
            val obj: JsonObject = element.asJsonObject
            val keys = obj.keySet().sorted()
            keys.joinToString(prefix = "{", postfix = "}") { key ->
                "\"${escape(key)}\":${canonicalJson(obj.get(key))}"
            }
        }
    }

    private fun escape(value: String): String = buildString {
        for (char in value) {
            when (char) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                '\b' -> append("\\b")
                '\u000C' -> append("\\f")
                // JSON.stringify と同じく、制御文字は小文字 4 桁の \uXXXX にする。
                else -> if (char < ' ') append("\\u" + char.code.toString(16).padStart(4, '0')) else append(char)
            }
        }
    }
}
