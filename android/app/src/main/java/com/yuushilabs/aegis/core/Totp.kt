package com.yuushilabs.aegis.core

/** RFC 6238 TOTP（HOTP の上に時間ステップを載せるだけ）。 */
object Totp {
    const val MIN_PERIOD = 1
    const val MAX_PERIOD = 300
    const val MAX_CLOCK_SKEW = 2

    fun currentStep(unixSeconds: Long, period: Int): Long {
        require(period in MIN_PERIOD..MAX_PERIOD) { "period は $MIN_PERIOD〜$MAX_PERIOD の整数である必要があります" }
        return Math.floorDiv(unixSeconds, period.toLong())
    }

    fun secondsRemaining(unixSeconds: Long, period: Int): Int {
        require(period >= MIN_PERIOD) { "period が不正です" }
        val elapsed = Math.floorMod(unixSeconds, period.toLong()).toInt()
        return period - elapsed
    }

    fun clampSkew(skew: Int): Int = skew.coerceIn(-MAX_CLOCK_SKEW, MAX_CLOCK_SKEW)

    fun generate(
        secret: String,
        unixSeconds: Long,
        algorithm: String = "SHA1",
        digits: Int = 6,
        period: Int = 30,
    ): String {
        val counter = currentStep(unixSeconds, period)
        return Hotp.generate(secret, counter, algorithm, digits)
    }

    data class Pair(
        val current: String,
        val next: String,
        val counter: Long,
        val remaining: Int,
    )

    /** 現在コード・次期コード・残り秒数をまとめて返す（表示用）。 */
    fun pair(
        secret: String,
        unixSeconds: Long,
        algorithm: String = "SHA1",
        digits: Int = 6,
        period: Int = 30,
        skew: Int = 0,
    ): Pair {
        val counter = currentStep(unixSeconds, period) + clampSkew(skew)
        val key = Base32.decode(secret)
        return Pair(
            current = Hotp.generate(key, counter, algorithm, digits),
            next = Hotp.generate(key, counter + 1, algorithm, digits),
            counter = counter,
            remaining = secondsRemaining(unixSeconds, period),
        )
    }

    /** 検証（±window ステップを許容）。 */
    fun verify(
        secret: String,
        token: String,
        unixSeconds: Long,
        algorithm: String = "SHA1",
        digits: Int = 6,
        period: Int = 30,
        window: Int = 1,
    ): Boolean {
        val key = Base32.decode(secret)
        val step = currentStep(unixSeconds, period)
        for (offset in -window..window) {
            if (Hotp.generate(key, step + offset, algorithm, digits) == token) return true
        }
        return false
    }
}
