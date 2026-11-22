package com.yuushilabs.zekey.core

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * バイト列と文字列の変換。Web 版 `shared/encoding.ts` と同じ結果になること。
 */
object Bytes {
    private val random = SecureRandom()

    fun utf8(text: String): ByteArray = text.toByteArray(Charsets.UTF_8)

    fun fromUtf8(bytes: ByteArray): String = String(bytes, Charsets.UTF_8)

    /** 標準 base64（パディングあり）。封筒の各フィールドはこの形式。 */
    fun base64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    fun base64Decode(text: String): ByteArray {
        val normalized = text.filterNot { it.isWhitespace() }
        return try {
            Base64.getDecoder().decode(normalized)
        } catch (error: IllegalArgumentException) {
            throw IllegalArgumentException("base64 として解釈できません", error)
        }
    }

    /** base64url（パディング無し）。同期トークン・ディープリンクに使う。 */
    fun base64Url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun base64UrlDecode(text: String): ByteArray {
        val normalized = text.filterNot { it.isWhitespace() }
            .replace('+', '-')
            .replace('/', '_')
        val padded = when (normalized.length % 4) {
            0 -> normalized
            2 -> "$normalized=="
            3 -> "$normalized="
            else -> throw IllegalArgumentException("base64url の長さが不正です")
        }
        return try {
            Base64.getUrlDecoder().decode(padded)
        } catch (error: IllegalArgumentException) {
            throw IllegalArgumentException("base64url として解釈できません", error)
        }
    }

    fun hex(bytes: ByteArray): String {
        val out = StringBuilder(bytes.size * 2)
        for (byte in bytes) {
            out.append(HEX[(byte.toInt() shr 4) and 0x0f])
            out.append(HEX[byte.toInt() and 0x0f])
        }
        return out.toString()
    }

    fun hexDecode(text: String): ByteArray {
        require(text.length % 2 == 0 && text.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) {
            "16 進文字列が不正です"
        }
        return ByteArray(text.length / 2) { index ->
            text.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
    }

    fun randomBytes(length: Int): ByteArray = ByteArray(length).also { random.nextBytes(it) }

    /** 長さも含めて一定時間で比較する。 */
    fun timingSafeEqual(a: ByteArray, b: ByteArray): Boolean {
        if (a.size != b.size) return false
        var diff = 0
        for (index in a.indices) {
            diff = diff or (a[index].toInt() xor b[index].toInt())
        }
        return diff == 0
    }

    fun sha256(bytes: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(bytes)

    fun sha256Hex(text: String): String = hex(sha256(utf8(text)))

    /** URI / QR のパーセントデコード（`+` は、指定したときだけ空白として扱う）。 */
    fun percentDecode(text: String, plusAsSpace: Boolean = false): String {
        val out = java.io.ByteArrayOutputStream(text.length)
        var index = 0
        var literalStart = 0

        fun flushLiteral(until: Int) {
            if (until <= literalStart) return
            // サロゲートペア（絵文字など）を 1 文字ずつ壊さないよう、まとめて UTF-8 にする。
            val bytes = text.substring(literalStart, until).toByteArray(Charsets.UTF_8)
            out.write(bytes, 0, bytes.size)
        }

        while (index < text.length) {
            val char = text[index]
            when {
                char == '%' -> {
                    flushLiteral(index)
                    if (index + 2 >= text.length) throw IllegalArgumentException("パーセントエンコードが不正です")
                    val code = text.substring(index + 1, index + 3).toIntOrNull(16)
                        ?: throw IllegalArgumentException("パーセントエンコードが不正です")
                    out.write(code)
                    index += 3
                    literalStart = index
                }
                char == '+' && plusAsSpace -> {
                    flushLiteral(index)
                    out.write(' '.code)
                    index += 1
                    literalStart = index
                }
                else -> index += 1
            }
        }
        flushLiteral(text.length)
        return fromUtf8(out.toByteArray())
    }

    private val HEX = "0123456789abcdef".toCharArray()
}

/**
 * RFC 4648 Base32（出力はパディング無し、入力は小文字・空白・`=` を許容）。
 * Web 版 `shared/base32.ts` と互換。
 */
object Base32 {
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    private val LOOKUP = IntArray(128) { -1 }.also { table ->
        ALPHABET.forEachIndexed { index, char -> table[char.code] = index }
    }

    class Base32Exception(message: String) : IllegalArgumentException(message)

    fun normalize(input: String): String =
        input.filterNot { it.isWhitespace() || it == '=' }.uppercase()

    fun encode(bytes: ByteArray): String {
        var buffer = 0
        var bits = 0
        val out = StringBuilder((bytes.size * 8 + 4) / 5)
        for (byte in bytes) {
            buffer = (buffer shl 8) or (byte.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                out.append(ALPHABET[(buffer shr (bits - 5)) and 31])
                bits -= 5
            }
            buffer = if (bits == 0) 0 else buffer and ((1 shl bits) - 1)
        }
        if (bits > 0) {
            out.append(ALPHABET[(buffer shl (5 - bits)) and 31])
        }
        return out.toString()
    }

    fun decode(input: String): ByteArray {
        val normalized = normalize(input)
        if (normalized.isEmpty()) throw Base32Exception("Base32 文字列が空です")
        for (char in normalized) {
            val code = char.code
            if (code >= LOOKUP.size || LOOKUP[code] < 0) {
                throw Base32Exception("Base32 に使用できない文字が含まれています: $char")
            }
        }
        val out = ArrayList<Byte>(normalized.length * 5 / 8)
        var buffer = 0
        var bits = 0
        for (char in normalized) {
            buffer = (buffer shl 5) or LOOKUP[char.code]
            bits += 5
            if (bits >= 8) {
                out.add(((buffer shr (bits - 8)) and 0xff).toByte())
                bits -= 8
            }
            buffer = if (bits == 0) 0 else buffer and ((1 shl bits) - 1)
        }
        if (bits >= 5) throw Base32Exception("Base32 文字列の長さが不正です")
        return out.toByteArray()
    }

    /** 未使用ビットの違いも同じ文字列に揃える（Web 版 canonicalBase32 と同じ）。 */
    fun canonical(input: String): String = encode(decode(input))

    fun isValid(input: String): Boolean = try {
        decode(input)
        true
    } catch (_: IllegalArgumentException) {
        false
    }
}
