package com.yuushilabs.aegis.core

/**
 * サイト版「📱 アプリでログイン」のディープリンク。
 *
 *   aegis://login#code=<base64url(syncToken の UTF-8)>&dek=<base64url(DEK 32B)>&name=<URL エンコードしたボルト名>
 *
 * 値はすべてフラグメントに置かれ、サーバーへは送られない（Web 版 `src/lib/appLogin.ts`）。
 * 受け取った側は、復号できることを確かめてからボルトを置き換える。
 */
data class AppLoginPayload(
    /** 同期トークン（base64url の文字列）。 */
    val token: String,
    /** アンロック済みのデータ鍵（32 バイト）。 */
    val dek: ByteArray,
    val vaultName: String,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is AppLoginPayload) return false
        return token == other.token && dek.contentEquals(other.dek) && vaultName == other.vaultName
    }

    override fun hashCode(): Int = (token.hashCode() * 31 + dek.contentHashCode()) * 31 + vaultName.hashCode()
}

class AppLoginException(message: String) : IllegalArgumentException(message)

object AppLogin {
    const val PREFIX = "aegis://login#"

    /** アプリからサイトへ渡す URL を組み立てる（テスト・確認用）。 */
    fun build(token: String, dek: ByteArray, vaultName: String): String {
        val code = Bytes.base64Url(Bytes.utf8(token))
        val key = Bytes.base64Url(dek)
        return "$PREFIX" + "code=$code&dek=$key&name=${Otpauth.encodeComponent(vaultName)}"
    }

    fun isAppLoginLink(uri: String): Boolean {
        val text = uri.trim()
        return text.startsWith("aegis://login", ignoreCase = true)
    }

    fun parse(uri: String): AppLoginPayload {
        val text = uri.trim()
        if (!isAppLoginLink(text)) throw AppLoginException("aegis://login ではありません")
        if (!text.contains('#')) throw AppLoginException("引き渡し情報（#code=…）がありません")
        val fragment = text.substringAfter('#')
        if (fragment.isEmpty()) throw AppLoginException("引き渡し情報（#code=…）がありません")

        val params = LinkedHashMap<String, String>()
        for (part in fragment.split('&')) {
            if (part.isEmpty()) continue
            val key = part.substringBefore('=')
            val rawValue = if (part.contains('=')) part.substringAfter('=') else ""
            params[key] = rawValue
        }

        val rawCode = params["code"] ?: throw AppLoginException("同期コードがありません")
        val rawDek = params["dek"] ?: throw AppLoginException("鍵がありません")

        val token = try {
            Bytes.fromUtf8(Bytes.base64UrlDecode(rawCode))
        } catch (_: IllegalArgumentException) {
            throw AppLoginException("同期コードを読み取れませんでした")
        }
        if (!SyncCode.isValidToken(token)) throw AppLoginException("同期コードが正しくありません")

        val dek = try {
            Bytes.base64UrlDecode(rawDek)
        } catch (_: IllegalArgumentException) {
            throw AppLoginException("鍵を読み取れませんでした")
        }
        if (dek.size != 32) throw AppLoginException("鍵の長さが正しくありません")

        val name = params["name"]?.let {
            try {
                Bytes.percentDecode(it, plusAsSpace = false)
            } catch (_: IllegalArgumentException) {
                it
            }
        }.orEmpty()

        return AppLoginPayload(token = token, dek = dek, vaultName = name.ifBlank { "メイン" })
    }
}
