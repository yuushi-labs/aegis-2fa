package com.yuushilabs.zekey.core

/**
 * 同期トークンとボルト ID。Web 版 `shared/sync.ts` / `src/lib/syncCodeInput.ts` と同じ。
 *
 * vaultId = hex(SHA-256(token))[0:32]
 * サーバーは vaultId と tokenHash（SHA-256 hex 全長）だけを保存する。
 */
object SyncCode {
    const val TOKEN_BYTES = 32
    const val VAULT_ID_LENGTH = 32

    fun generateToken(): String = Bytes.base64Url(Bytes.randomBytes(TOKEN_BYTES))

    fun isValidToken(token: String): Boolean {
        if (!Regex("^[A-Za-z0-9_-]{40,64}$").matches(token)) return false
        return try {
            Bytes.base64UrlDecode(token).size == TOKEN_BYTES
        } catch (_: IllegalArgumentException) {
            false
        }
    }

    fun deriveVaultId(token: String): String = Bytes.sha256Hex(token).take(VAULT_ID_LENGTH)

    fun deriveTokenHash(token: String): String = Bytes.sha256Hex(token)

    fun isValidVaultId(id: String): Boolean = Regex("^[0-9a-f]{32}$").matches(id)

    /** 4 文字区切りで表示する。 */
    fun format(token: String): String = token.chunked(4).joinToString(" ")

    fun normalize(input: String): String = input.filterNot { it.isWhitespace() }

    private fun asToken(value: String): String? {
        val normalized = normalize(value)
        return if (isValidToken(normalized)) normalized else null
    }

    private fun pickParam(query: String): String? {
        val params = LinkedHashMap<String, String>()
        for (part in query.split('&')) {
            if (part.isEmpty()) continue
            val key = part.substringBefore('=')
            val value = if (part.contains('=')) part.substringAfter('=') else ""
            if (!params.containsKey(key)) params[key] = value
        }
        for (name in listOf("code", "sync", "token")) {
            val value = params[name]
            if (!value.isNullOrBlank()) return value
        }
        return null
    }

    /** URL 形式の文字列から同期コードを取り出す。 */
    fun extractFromUrl(input: String): String? {
        val text = input.trim()
        if (text.isEmpty()) return null
        val looksLikeUrl = Regex("^[a-z][a-z0-9+.-]*:", RegexOption.IGNORE_CASE).containsMatchIn(text) ||
            text.startsWith("/")
        if (!looksLikeUrl) return null

        // scheme://authority/path?query#fragment を手で分ける（相対パスも受ける）。
        var body = text
        val schemeEnd = body.indexOf("://")
        if (schemeEnd != -1) body = body.substring(schemeEnd + 3)

        val hashIndex = body.indexOf('#')
        val fragment = if (hashIndex == -1) "" else body.substring(hashIndex + 1)
        val beforeHash = if (hashIndex == -1) body else body.substring(0, hashIndex)
        val queryIndex = beforeHash.indexOf('?')
        val query = if (queryIndex == -1) "" else beforeHash.substring(queryIndex + 1)
        val pathAndAuthority = if (queryIndex == -1) beforeHash else beforeHash.substring(0, queryIndex)
        val slashIndex = pathAndAuthority.indexOf('/')
        val path = if (slashIndex == -1) "" else pathAndAuthority.substring(slashIndex)

        val fromQuery = pickParam(query)
        if (fromQuery != null) {
            val token = asToken(safeDecode(fromQuery))
            if (token != null) return token
        }

        if (fragment.isNotEmpty()) {
            if (fragment.contains('=')) {
                val fromHash = pickParam(fragment)
                if (fromHash != null) {
                    val token = asToken(safeDecode(fromHash))
                    if (token != null) return token
                }
            } else {
                val token = asToken(safeDecode(fragment))
                if (token != null) return token
            }
        }

        val segments = path.split('/').filter { it.isNotEmpty() }
        val last = segments.lastOrNull()
        if (last != null) {
            val token = asToken(safeDecode(last))
            if (token != null) return token
        }
        return null
    }

    /** 手入力・貼り付け・QR のどれでも、文字列から同期コードを取り出す。 */
    fun extract(input: String): String? {
        val text = input.trim()
        if (text.isEmpty()) return null
        return asToken(text) ?: extractFromUrl(text)
    }

    private fun safeDecode(value: String): String = try {
        Bytes.percentDecode(value, plusAsSpace = false)
    } catch (_: IllegalArgumentException) {
        value
    }
}
