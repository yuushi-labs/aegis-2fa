package com.yuushilabs.aegis.core

/**
 * 重複チェック。Web 版 `shared/duplicates.ts` と同じ判定。
 *
 * 追加しようとしているアカウントが、ゴミ箱にない既存アカウントと
 * - 正規化した秘密鍵が同じ、または
 * - サービス名 + アカウント名（大文字小文字・前後空白を無視）が同じ
 * なら、理由付きで知らせる。
 */
enum class DuplicateReason { SECRET, LABEL }

data class DuplicateMatch(
    val account: Account,
    val reasons: List<DuplicateReason>,
)

object Duplicates {
    private fun normaliseSecret(value: String): String = try {
        Base32.canonical(value)
    } catch (_: IllegalArgumentException) {
        value.replace(" ", "").replace("-", "").uppercase()
    }

    private fun labelKey(issuer: String, label: String): String =
        "${issuer.trim().lowercase()}\u0000${label.trim().lowercase()}"

    fun findDuplicates(existing: List<Account>, candidate: Account): List<DuplicateMatch> {
        val secret = normaliseSecret(candidate.secret)
        val key = labelKey(candidate.issuer, candidate.label)
        val matches = ArrayList<DuplicateMatch>()
        for (account in existing) {
            if (account.isTrashed) continue
            val reasons = ArrayList<DuplicateReason>(2)
            if (secret.isNotEmpty() && normaliseSecret(account.secret) == secret) {
                reasons.add(DuplicateReason.SECRET)
            }
            if (key != "\u0000" && labelKey(account.issuer, account.label) == key) {
                reasons.add(DuplicateReason.LABEL)
            }
            if (reasons.isNotEmpty()) matches.add(DuplicateMatch(account, reasons))
        }
        return matches
    }

    fun describe(reason: DuplicateReason): String = when (reason) {
        DuplicateReason.SECRET -> "同じ秘密鍵"
        DuplicateReason.LABEL -> "同じサービス名とアカウント名"
    }
}
