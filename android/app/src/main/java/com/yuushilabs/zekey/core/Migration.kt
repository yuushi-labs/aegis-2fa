package com.yuushilabs.zekey.core

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * Google Authenticator 移行 URI（`otpauth-migration://offline?data=<base64url>`）の
 * Protobuf デコーダ。Web 版 `shared/migration.ts` と同じ判定・スキップ規則。
 *
 * MigrationPayload { repeated OtpParameters otp_parameters = 1; int32 version = 2;
 *                    int32 batch_size = 3; int32 batch_index = 4; int32 batch_id = 5; }
 * OtpParameters { bytes secret = 1; string name = 2; string issuer = 3;
 *                 Algorithm algorithm = 4; DigitCount digits = 5; OtpType type = 6; int64 counter = 7; }
 */
class MigrationException(message: String) : IllegalArgumentException(message)

data class MigrationEntry(
    val secret: String,
    val name: String,
    val issuer: String,
    val algorithm: String,
    val digits: Int,
    val type: String,
    val counter: Long,
)

data class MigrationResult(
    val entries: List<MigrationEntry>,
    val skipped: Int,
    val skipReasons: List<String>,
    val version: Int,
    val batchSize: Int,
    val batchIndex: Int,
    val batchId: Int,
)

object Migration {
    private object WireType {
        const val VARINT = 0
        const val FIXED64 = 1
        const val LENGTH_DELIMITED = 2
        const val START_GROUP = 3
        const val END_GROUP = 4
        const val FIXED32 = 5
    }

    private class Field(
        val fieldNumber: Int,
        val wireType: Int,
        val bytes: ByteArray? = null,
        val varint: Long = 0L,
    )

    private class Reader(private val bytes: ByteArray) {
        private var offset = 0

        val done: Boolean get() = offset >= bytes.size

        fun readVarint(): Long {
            var result = 0L
            var shift = 0
            var byteCount = 0
            while (true) {
                if (offset >= bytes.size) throw MigrationException("Protobuf の可変長整数が途中で終わっています")
                val byte = bytes[offset].toInt() and 0xff
                offset += 1
                byteCount += 1
                if (byteCount == 10 && (byte and 0x7f) > 1) {
                    throw MigrationException("可変長整数が大きすぎます")
                }
                result = result or ((byte and 0x7f).toLong() shl shift)
                if (byte and 0x80 == 0) break
                shift += 7
                if (shift > 63) throw MigrationException("可変長整数が大きすぎます")
            }
            return result
        }

        fun readBytes(length: Int): ByteArray {
            if (length < 0 || offset + length > bytes.size) {
                throw MigrationException("Protobuf の長さ指定が範囲外です")
            }
            val slice = bytes.copyOfRange(offset, offset + length)
            offset += length
            return slice
        }

        fun readFixed(length: Int): Long {
            val slice = readBytes(length)
            var value = 0L
            for (index in 0 until length) {
                value = value or ((slice[index].toLong() and 0xff) shl (8 * index))
            }
            return value
        }

        fun readTag(): kotlin.Pair<Int, Int> {
            val tag = readVarint()
            if (tag < 0) throw MigrationException("フィールド番号が不正です")
            val fieldNumber = (tag / 8).toInt()
            val wireType = (tag % 8).toInt()
            if (fieldNumber == 0) throw MigrationException("フィールド番号 0 は不正です")
            return fieldNumber to wireType
        }

        fun skip(wireType: Int) {
            when (wireType) {
                WireType.VARINT -> readVarint()
                WireType.FIXED64 -> readBytes(8)
                WireType.LENGTH_DELIMITED -> readBytes(readVarint().toInt())
                WireType.FIXED32 -> readBytes(4)
                else -> throw MigrationException("未対応の wire type です: $wireType")
            }
        }
    }

    private fun readFields(bytes: ByteArray): List<Field> {
        val reader = Reader(bytes)
        val fields = ArrayList<Field>()
        while (!reader.done) {
            val (fieldNumber, wireType) = reader.readTag()
            when (wireType) {
                WireType.VARINT -> fields.add(Field(fieldNumber, wireType, varint = reader.readVarint()))
                WireType.LENGTH_DELIMITED -> fields.add(
                    Field(fieldNumber, wireType, bytes = reader.readBytes(reader.readVarint().toInt())),
                )
                WireType.FIXED32 -> fields.add(Field(fieldNumber, wireType, varint = reader.readFixed(4)))
                WireType.FIXED64 -> fields.add(Field(fieldNumber, wireType, varint = reader.readFixed(8)))
                else -> throw MigrationException("未対応の wire type です: $wireType")
            }
        }
        return fields
    }

    private fun last(fields: List<Field>, number: Int): Field? = fields.lastOrNull { it.fieldNumber == number }

    /** int32 フィールドを符号付きで解釈する（負の値は 10 バイトの varint になる）。 */
    private fun asInt32(field: Field?): Int {
        if (field == null) return 0
        return field.varint.toInt()
    }

    /** int64 フィールド。安全整数の範囲外は null（Web 版と同じ）。 */
    private fun asInt64(field: Field?): Long? {
        if (field == null) return 0L
        val value = field.varint
        if (value > MAX_SAFE_INTEGER || value < -MAX_SAFE_INTEGER) return null
        return value
    }

    private fun asString(field: Field?): String {
        val bytes = field?.bytes ?: return ""
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        return try {
            decoder.decode(ByteBuffer.wrap(bytes)).toString()
        } catch (_: CharacterCodingException) {
            throw MigrationException("Protobuf の文字列が UTF-8 ではありません")
        }
    }

    fun decodeOtpParameters(bytes: ByteArray): kotlin.Pair<MigrationEntry?, String?> {
        val fields = readFields(bytes)
        val secretBytes = last(fields, 1)?.bytes
        if (secretBytes == null || secretBytes.isEmpty()) return null to "秘密鍵が空です"
        val secret = Base32.encode(secretBytes)

        val algorithmEnum = asInt32(last(fields, 4))
        val digitsEnum = asInt32(last(fields, 5))
        val typeEnum = asInt32(last(fields, 6))
        if (algorithmEnum == 4) return null to "MD5 は未対応です"
        val algorithm = when (algorithmEnum) {
            1 -> "SHA1"
            2 -> "SHA256"
            3 -> "SHA512"
            else -> return null to "不明なアルゴリズムです ($algorithmEnum)"
        }
        val digits = when (digitsEnum) {
            1 -> 6
            2 -> 8
            else -> return null to "不明な桁数です ($digitsEnum)"
        }
        val type = when (typeEnum) {
            1 -> "hotp"
            2 -> "totp"
            else -> return null to "不明な種別です ($typeEnum)"
        }
        // counter は HOTP だけが使う。TOTP の値が壊れていても取り込みは止めない
        // （Google Authenticator は TOTP に 0 を書くが、値の範囲は意味を持たない）。
        val counterValue = asInt64(last(fields, 7))
        if (type == "hotp" && (counterValue == null || counterValue < 0)) {
            return null to "HOTP のカウンタが不正です"
        }

        val name = asString(last(fields, 2))
        val issuer = asString(last(fields, 3))
        return MigrationEntry(
            secret = secret,
            name = name,
            issuer = issuer,
            algorithm = algorithm,
            digits = digits,
            type = type,
            counter = if (type == "hotp") (counterValue ?: 0L) else 0L,
        ) to null
    }

    fun decodePayload(data: ByteArray): MigrationResult {
        val fields = readFields(data)
        val entries = ArrayList<MigrationEntry>()
        val skipReasons = ArrayList<String>()
        for (field in fields) {
            if (field.fieldNumber != 1) continue
            val payload = field.bytes ?: continue
            val (entry, reason) = decodeOtpParameters(payload)
            if (entry != null) entries.add(entry) else skipReasons.add(reason ?: "不明な理由")
        }
        return MigrationResult(
            entries = entries,
            skipped = skipReasons.size,
            skipReasons = skipReasons,
            version = asInt32(last(fields, 2)),
            batchSize = asInt32(last(fields, 3)),
            batchIndex = asInt32(last(fields, 4)),
            batchId = asInt32(last(fields, 5)),
        )
    }

    /** `otpauth-migration://offline?data=...` をデコードする。 */
    fun parseUri(uri: String): MigrationResult {
        val trimmed = uri.trim()
        if (!trimmed.startsWith("otpauth-migration://", ignoreCase = true)) throw MigrationException("otpauth-migration:// ではありません")
        val hashIndex = trimmed.indexOf('#')
        val withoutHash = if (hashIndex == -1) trimmed else trimmed.substring(0, hashIndex)
        val queryIndex = withoutHash.indexOf('?')
        val query = if (queryIndex == -1) "" else withoutHash.substring(queryIndex + 1)
        val data = query.split('&').firstOrNull { part ->
            val key = part.substringBefore('=')
            key == "data"
        }?.substringAfter('=', "")?.takeIf { it.isNotEmpty() }
            ?: throw MigrationException("data パラメータがありません")
        val decoded = try {
            Bytes.base64UrlDecode(Bytes.percentDecode(data, plusAsSpace = true))
        } catch (_: IllegalArgumentException) {
            throw MigrationException("data が base64url として不正です")
        }
        if (decoded.isEmpty()) throw MigrationException("data が空です")
        return try {
            val result = decodePayload(decoded)
            if (result.entries.isEmpty() && result.skipped == 0) {
                throw MigrationException("移行データにアカウントが含まれていません")
            }
            result
        } catch (error: MigrationException) {
            throw error
        } catch (error: Exception) {
            throw MigrationException("この QR は読み取れませんでした")
        }
    }

    /** 移行エントリをアカウントへ変換する（Web 版 migrationEntryToAccount と同じ）。 */
    fun entryToAccount(entry: MigrationEntry, id: String, now: String, order: Int): Account {
        val colonIndex = entry.name.indexOf(':')
        val nameIssuer = if (colonIndex == -1) "" else entry.name.substring(0, colonIndex).trim()
        val nameLabel = if (colonIndex == -1) entry.name else entry.name.substring(colonIndex + 1).trim()
        val issuer = if (entry.issuer.isNotEmpty()) entry.issuer else nameIssuer
        val prefix = if (entry.issuer.isNotEmpty()) "${entry.issuer}:" else ""
        val stripPrefix = if (entry.issuer.isNotEmpty()) {
            entry.name.startsWith(prefix)
        } else {
            colonIndex != -1 && nameIssuer.isNotEmpty()
        }
        val stripped = if (stripPrefix) {
            if (entry.issuer.isNotEmpty()) entry.name.removePrefix(prefix) else nameLabel
        } else {
            entry.name
        }
        val label = if (stripPrefix && stripped.isEmpty()) entry.name else stripped
        return Account(
            id = id,
            type = entry.type,
            issuer = issuer,
            label = label.ifEmpty { "アカウント" },
            secret = entry.secret,
            algorithm = entry.algorithm,
            digits = entry.digits,
            period = 30,
            counter = entry.counter,
            pinned = false,
            order = order,
            createdAt = now,
            updatedAt = now,
        )
    }

    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
}
