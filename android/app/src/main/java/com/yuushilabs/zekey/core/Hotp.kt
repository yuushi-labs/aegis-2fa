package com.yuushilabs.zekey.core

/**
 * RFC 4226 HOTP。HMAC は JCE（Web 版の Web Crypto と同じ結果になる）。
 */
object Hotp {
    const val MAX_DIGITS = 10

    fun counterToBytes(counter: Long): ByteArray {
        require(counter >= 0) { "カウンタは 0 以上の整数である必要があります" }
        val bytes = ByteArray(8)
        var value = counter
        for (index in 7 downTo 0) {
            bytes[index] = (value and 0xff).toByte()
            value = value ushr 8
        }
        return bytes
    }

    fun dynamicTruncate(digest: ByteArray): Int {
        val offset = digest[digest.size - 1].toInt() and 0x0f
        return (((digest[offset].toInt() and 0x7f) shl 24) or
            ((digest[offset + 1].toInt() and 0xff) shl 16) or
            ((digest[offset + 2].toInt() and 0xff) shl 8) or
            (digest[offset + 3].toInt() and 0xff))
    }

    fun truncateToDigits(binaryCode: Int, digits: Int): String {
        require(digits in 1..MAX_DIGITS) { "桁数は 1〜10 の整数である必要があります" }
        var modulo = 1L
        repeat(digits) { modulo *= 10 }
        val value = (binaryCode.toLong() and 0xffffffffL) % modulo
        return value.toString().padStart(digits, '0')
    }

    fun generate(key: ByteArray, counter: Long, algorithm: String = "SHA1", digits: Int = 6): String {
        val digest = Crypto.hmac(algorithm, key, counterToBytes(counter))
        return truncateToDigits(dynamicTruncate(digest), digits)
    }

    /** Base32 秘密鍵から生成する。 */
    fun generate(secret: String, counter: Long, algorithm: String = "SHA1", digits: Int = 6): String =
        generate(Base32.decode(secret), counter, algorithm, digits)
}
