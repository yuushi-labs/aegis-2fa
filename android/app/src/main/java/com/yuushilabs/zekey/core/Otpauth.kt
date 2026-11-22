package com.yuushilabs.zekey.core

/**
 * `otpauth://` URI のパースと生成。Web 版 `shared/otpauth.ts` と同じ規則。
 *
 * otpauth://totp/Issuer:account?secret=...&issuer=...&algorithm=SHA1&digits=6&period=30
 * otpauth://hotp/Issuer:account?secret=...&issuer=...&counter=0
 */
class OtpauthException(message: String) : IllegalArgumentException(message)

data class OtpauthParams(
    val type: String,
    val issuer: String,
    val label: String,
    val secret: String,
    val algorithm: String,
    val digits: Int,
    val period: Int,
    val counter: Long,
)

object Otpauth {
    private val ALGORITHMS = setOf("SHA1", "SHA256", "SHA512")

    fun isOtpauthUri(value: String): Boolean = value.trim().startsWith("otpauth://", ignoreCase = true)

    fun isMigrationUri(value: String): Boolean =
        value.trim().startsWith("otpauth-migration://", ignoreCase = true)

    /**
     * "Issuer:account" を分解する。区切りが無ければ issuer は空。
     *
     * 区切りは**エスケープ前の生の ':'** で探し、両側を別々にデコードする。
     * こうしないと issuer に含まれる ":"（%3A）を区切りと誤認し、
     * build → parse の往復でラベルが変わる。
     */
    fun splitLabel(pathLabel: String): kotlin.Pair<String, String> {
        val index = pathLabel.indexOf(':')
        val rawIssuer = if (index == -1) "" else pathLabel.substring(0, index)
        val rawLabel = if (index == -1) pathLabel else pathLabel.substring(index + 1)
        return decodeOrRaw(rawIssuer).trim() to decodeOrRaw(rawLabel).trim()
    }

    private fun decodeOrRaw(value: String): String = try {
        Bytes.percentDecode(value)
    } catch (_: IllegalArgumentException) {
        value
    }

    private fun parseStrictInteger(raw: String, param: String): Long {
        val trimmed = raw.trim()
        if (trimmed.isEmpty() || trimmed.any { it !in '0'..'9' }) {
            throw OtpauthException("$param は整数である必要があります: $raw")
        }
        return trimmed.toLongOrNull() ?: throw OtpauthException("$param が大きすぎます: $raw")
    }

    private fun normalizeAlgorithm(raw: String?): String {
        if (raw == null || raw.trim().isEmpty()) return "SHA1"
        val upper = raw.trim().uppercase().replace("-", "")
        if (upper !in ALGORITHMS) throw OtpauthException("未対応のアルゴリズムです: $raw")
        return upper
    }

    private fun normalizeDigits(raw: String?): Int {
        if (raw == null || raw.trim().isEmpty()) return 6
        val value = parseStrictInteger(raw, "digits")
        if (value != 6L && value != 8L) throw OtpauthException("桁数は 6 か 8 のみ対応しています: $raw")
        return value.toInt()
    }

    private fun normalizePeriod(raw: String?): Int {
        if (raw == null || raw.trim().isEmpty()) return 30
        val value = parseStrictInteger(raw, "period")
        if (value < Totp.MIN_PERIOD || value > Totp.MAX_PERIOD) {
            throw OtpauthException("period は ${Totp.MIN_PERIOD}〜${Totp.MAX_PERIOD} の整数である必要があります: $raw")
        }
        return value.toInt()
    }

    private fun normalizeCounter(raw: String?): Long {
        if (raw == null || raw.trim().isEmpty()) return 0L
        return parseStrictInteger(raw, "counter")
    }

    private fun parseQuery(query: String): Map<String, String> {
        val result = LinkedHashMap<String, String>()
        if (query.isEmpty()) return result
        for (part in query.split('&')) {
            if (part.isEmpty()) continue
            val index = part.indexOf('=')
            val rawKey = if (index == -1) part else part.substring(0, index)
            val rawValue = if (index == -1) "" else part.substring(index + 1)
            val key = try {
                Bytes.percentDecode(rawKey, plusAsSpace = true)
            } catch (_: IllegalArgumentException) {
                rawKey
            }
            val value = try {
                Bytes.percentDecode(rawValue, plusAsSpace = true)
            } catch (_: IllegalArgumentException) {
                rawValue
            }
            // URLSearchParams は同じ名前なら先頭を返す。
            if (!result.containsKey(key)) result[key] = value
        }
        return result
    }

    fun parse(uri: String): OtpauthParams {
        val text = uri.trim()
        if (!isOtpauthUri(text)) throw OtpauthException("otpauth:// スキームではありません")
        var rest = text.substring("otpauth://".length)
        val hashIndex = rest.indexOf('#')
        if (hashIndex != -1) rest = rest.substring(0, hashIndex)
        val queryIndex = rest.indexOf('?')
        val query = if (queryIndex == -1) "" else rest.substring(queryIndex + 1)
        val pathPart = if (queryIndex == -1) rest else rest.substring(0, queryIndex)
        val slashIndex = pathPart.indexOf('/')
        val host = (if (slashIndex == -1) pathPart else pathPart.substring(0, slashIndex)).lowercase()
        val path = if (slashIndex == -1) "" else pathPart.substring(slashIndex + 1).trimStart('/')

        if (host != "totp" && host != "hotp") throw OtpauthException("未対応の種別です: $host")
        val queryParams = parseQuery(query)

        val rawSecret = queryParams["secret"]
        if (rawSecret == null || rawSecret.trim().isEmpty()) throw OtpauthException("secret パラメータがありません")
        val secret = try {
            Base32.canonical(rawSecret)
        } catch (_: IllegalArgumentException) {
            throw OtpauthException("secret が正しい Base32 ではありません")
        }

        val (labelIssuer, label) = splitLabel(path)
        val queryIssuer = queryParams["issuer"]
        val issuer = if (!queryIssuer.isNullOrBlank()) queryIssuer.trim() else labelIssuer

        val params = OtpauthParams(
            type = host,
            issuer = issuer,
            label = label,
            secret = secret,
            algorithm = normalizeAlgorithm(queryParams["algorithm"]),
            digits = normalizeDigits(queryParams["digits"]),
            period = if (host == "totp") normalizePeriod(queryParams["period"]) else 30,
            counter = if (host == "hotp") normalizeCounter(queryParams["counter"]) else 0L,
        )
        if (params.label.isEmpty() && params.issuer.isEmpty()) {
            throw OtpauthException("ラベル（アカウント名）がありません")
        }
        return params
    }

    /** URI を生成する（往復で意味が変わらないこと）。 */
    fun build(account: Account): String {
        val path = if (account.issuer.isNotEmpty()) {
            "${encodeComponent(account.issuer)}:${encodeComponent(account.label)}"
        } else {
            encodeComponent(account.label)
        }
        val params = StringBuilder()
        params.append("secret=").append(encodeComponent(account.secret))
        if (account.issuer.isNotEmpty()) params.append("&issuer=").append(encodeComponent(account.issuer))
        params.append("&algorithm=").append(account.algorithm)
        params.append("&digits=").append(account.digits)
        if (account.type == "totp") {
            params.append("&period=").append(account.period)
        } else {
            params.append("&counter=").append(account.counter)
        }
        return "otpauth://${account.type}/$path?$params"
    }

    /** `encodeURIComponent` と同じく、英数字と `-_.!~*'()` 以外を %XX にする。 */
    fun encodeComponent(value: String): String {
        val out = StringBuilder()
        for (byte in Bytes.utf8(value)) {
            val code = byte.toInt() and 0xff
            val char = code.toChar()
            if (char in 'A'..'Z' || char in 'a'..'z' || char in '0'..'9' ||
                char == '-' || char == '_' || char == '.' || char == '!' || char == '~' ||
                char == '*' || char == '\'' || char == '(' || char == ')'
            ) {
                out.append(char)
            } else {
                out.append('%').append(HEX[(code shr 4) and 0x0f]).append(HEX[code and 0x0f])
            }
        }
        return out.toString()
    }

    /** パース結果を新しいアカウントの下書きにする。 */
    fun toAccountDraft(params: OtpauthParams): Account = Account(
        type = params.type,
        issuer = params.issuer,
        label = params.label,
        secret = params.secret,
        algorithm = params.algorithm,
        digits = params.digits,
        period = params.period,
        counter = params.counter,
    )

    private val HEX = "0123456789ABCDEF".toCharArray()
}
