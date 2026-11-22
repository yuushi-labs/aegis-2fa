package com.yuushilabs.zekey.core

import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Web 版の `new Date().toISOString()` と同じ形式（ミリ秒 3 桁 + Z）で時刻を扱う。 */
object IsoTime {
    private val formatter: DateTimeFormatter =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).withZone(ZoneOffset.UTC)

    fun now(): String = formatter.format(Instant.now())

    fun format(epochMillis: Long): String = formatter.format(Instant.ofEpochMilli(epochMillis))

    /** ISO 8601 をミリ秒へ。解釈できない値は null（壊れた日時で勝手に消さないため）。 */
    fun parseOrNull(text: String?): Long? {
        if (text.isNullOrBlank()) return null
        val trimmed = text.trim()
        return try {
            Instant.parse(trimmed).toEpochMilli()
        } catch (_: Exception) {
            try {
                OffsetDateTime.parse(trimmed).toInstant().toEpochMilli()
            } catch (_: Exception) {
                try {
                    LocalDate.parse(trimmed).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
                } catch (_: Exception) {
                    null
                }
            }
        }
    }
}
