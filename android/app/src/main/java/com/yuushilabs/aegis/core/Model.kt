package com.yuushilabs.aegis.core

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonSyntaxException

/**
 * Web 版 `shared/types.ts` と同じ形。暗号化ペイロード（VaultData）の中身だけを広げ、
 * サーバー API とスキーマは変えない。
 */
data class Account(
    val id: String = "",
    /** "totp" / "hotp" */
    val type: String = "totp",
    val issuer: String = "",
    val label: String = "",
    /** Base32（パディング無し・大文字正規化） */
    val secret: String = "",
    /** "SHA1" / "SHA256" / "SHA512" */
    val algorithm: String = "SHA1",
    val digits: Int = 6,
    val period: Int = 30,
    val counter: Long = 0L,
    val pinned: Boolean = false,
    val order: Int = 0,
    val createdAt: String = "",
    val updatedAt: String = "",
    val notes: String? = null,
    val recoveryCodes: List<RecoveryCode>? = null,
    val deletedAt: String? = null,
    val useCount: Long? = null,
    val lastUsedAt: String? = null,
) {
    val isTotp: Boolean get() = type != "hotp"
    val isTrashed: Boolean get() = !deletedAt.isNullOrEmpty()
    val displayName: String get() = if (issuer.isNotBlank()) issuer else label.ifBlank { "アカウント" }
    val unusedRecoveryCodes: Int get() = recoveryCodes?.count { !it.used } ?: 0
    val hasNotes: Boolean get() = !notes.isNullOrBlank()
}

data class RecoveryCode(
    val id: String = "",
    val code: String = "",
    val used: Boolean = false,
)

data class Tombstone(
    val id: String = "",
    val deletedAt: String = "",
)

data class SyncDevice(
    val id: String = "",
    val name: String = "",
    val platform: String = "",
    val lastSyncedAt: String = "",
)

data class VaultData(
    val accounts: List<Account> = emptyList(),
    val tombstones: List<Tombstone>? = null,
    val devices: List<SyncDevice>? = null,
)

data class VaultKdf(
    val name: String = "PBKDF2-SHA256",
    val iterations: Int = Crypto.PBKDF2_ITERATIONS,
    val salt: String = "",
)

data class VaultCipher(
    val iv: String = "",
    val ciphertext: String = "",
)

data class VaultEnvelope(
    val format: String = "aegis-vault",
    val version: Int = 1,
    val kdf: VaultKdf = VaultKdf(),
    val wrappedKey: VaultCipher = VaultCipher(),
    val data: VaultCipher = VaultCipher(),
    val verifier: String = "",
    val revision: Int = 1,
    val updatedAt: String = "",
)

/** ボルト（プロファイル）。マスターパスワードごとに独立する。 */
data class VaultProfile(
    val id: String = "main",
    val name: String = "メイン",
    val createdAt: String = "",
)

/**
 * 暗号化ペイロードの JSON 変換。Web 版と同じキー名・同じ欠損の扱いにする。
 * 不明なキーは読み飛ばし、壊れた要素は落とす（読めないデータでアプリ全体を止めない）。
 */
object VaultJson {
    val gson: Gson = GsonBuilder().create()

    /** 封筒を JSON から読む（欠損フィールドは既定値にして null 参照を作らない）。 */
    fun parseEnvelope(text: String): VaultEnvelope? {
        val root = try {
            JsonParser.parseString(text)
        } catch (_: Exception) {
            return null
        }
        if (!root.isJsonObject) return null
        return readEnvelope(root.asJsonObject)
    }

    fun readEnvelope(obj: JsonObject): VaultEnvelope {
        val kdf = obj.get("kdf")?.takeIf { it.isJsonObject }?.asJsonObject
        val wrappedKey = obj.get("wrappedKey")?.takeIf { it.isJsonObject }?.asJsonObject
        val data = obj.get("data")?.takeIf { it.isJsonObject }?.asJsonObject
        return VaultEnvelope(
            format = obj.stringOrNull("format") ?: "",
            version = obj.intOrNull("version") ?: 0,
            kdf = VaultKdf(
                name = kdf?.stringOrNull("name") ?: "",
                iterations = kdf?.intOrNull("iterations") ?: 0,
                salt = kdf?.stringOrNull("salt") ?: "",
            ),
            wrappedKey = VaultCipher(
                iv = wrappedKey?.stringOrNull("iv") ?: "",
                ciphertext = wrappedKey?.stringOrNull("ciphertext") ?: "",
            ),
            data = VaultCipher(
                iv = data?.stringOrNull("iv") ?: "",
                ciphertext = data?.stringOrNull("ciphertext") ?: "",
            ),
            verifier = obj.stringOrNull("verifier") ?: "",
            revision = obj.intOrNull("revision") ?: 0,
            updatedAt = obj.stringOrNull("updatedAt") ?: "",
        )
    }

    fun serializeEnvelope(envelope: VaultEnvelope): String = gson.toJson(envelope)

    fun parse(plaintext: String): VaultData {
        val root = try {
            JsonParser.parseString(plaintext)
        } catch (error: JsonSyntaxException) {
            throw IllegalArgumentException("ボルトの JSON を解釈できません", error)
        }
        if (!root.isJsonObject) throw IllegalArgumentException("ボルトの JSON がオブジェクトではありません")
        val obj = root.asJsonObject

        val accounts = ArrayList<Account>()
        val rawAccounts = obj.get("accounts")
        if (rawAccounts != null && rawAccounts.isJsonArray) {
            for (element in rawAccounts.asJsonArray) {
                if (!element.isJsonObject) continue
                val item = element.asJsonObject
                if (item.stringOrNull("id").isNullOrEmpty()) continue
                accounts.add(readAccount(item))
            }
        }

        val tombstones = ArrayList<Tombstone>()
        val rawTombstones = obj.get("tombstones")
        if (rawTombstones != null && rawTombstones.isJsonArray) {
            for (element in rawTombstones.asJsonArray) {
                if (!element.isJsonObject) continue
                val item = element.asJsonObject
                val id = item.stringOrNull("id") ?: continue
                val deletedAt = item.stringOrNull("deletedAt") ?: continue
                tombstones.add(Tombstone(id, deletedAt))
            }
        }

        val devices = ArrayList<SyncDevice>()
        val rawDevices = obj.get("devices")
        if (rawDevices != null && rawDevices.isJsonArray) {
            for (element in rawDevices.asJsonArray) {
                if (!element.isJsonObject) continue
                val item = element.asJsonObject
                val id = item.stringOrNull("id") ?: continue
                if (id.isEmpty()) continue
                devices.add(
                    SyncDevice(
                        id = id,
                        name = item.stringOrNull("name").orEmpty(),
                        platform = item.stringOrNull("platform").orEmpty(),
                        lastSyncedAt = item.stringOrNull("lastSyncedAt").orEmpty(),
                    ),
                )
            }
        }

        return VaultData(
            accounts = accounts,
            tombstones = tombstones,
            devices = devices,
        )
    }

    /** 1 件分を既定値付きで読む（Gson に任せると欠損フィールドが null になるため）。 */
    fun readAccount(item: JsonObject): Account {
        val recoveryCodes = ArrayList<RecoveryCode>()
        val rawCodes = item.get("recoveryCodes")
        if (rawCodes != null && rawCodes.isJsonArray) {
            for (element in rawCodes.asJsonArray) {
                if (!element.isJsonObject) continue
                val code = element.asJsonObject
                recoveryCodes.add(
                    RecoveryCode(
                        id = code.stringOrNull("id").orEmpty().ifEmpty { "" },
                        code = code.stringOrNull("code").orEmpty(),
                        used = code.get("used")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false,
                    ),
                )
            }
        }
        return Account(
            id = item.stringOrNull("id").orEmpty(),
            type = if (item.stringOrNull("type") == "hotp") "hotp" else "totp",
            issuer = item.stringOrNull("issuer").orEmpty(),
            label = item.stringOrNull("label").orEmpty(),
            secret = item.stringOrNull("secret").orEmpty(),
            algorithm = when (item.stringOrNull("algorithm")?.uppercase()?.replace("-", "")) {
                "SHA256" -> "SHA256"
                "SHA512" -> "SHA512"
                else -> "SHA1"
            },
            digits = if (item.intOrNull("digits") == 8) 8 else 6,
            period = item.intOrNull("period")?.takeIf { it in 1..300 } ?: 30,
            counter = item.longOrNull("counter")?.takeIf { it >= 0 } ?: 0L,
            pinned = item.get("pinned")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false,
            order = item.intOrNull("order") ?: 0,
            createdAt = item.stringOrNull("createdAt").orEmpty(),
            updatedAt = item.stringOrNull("updatedAt").orEmpty(),
            notes = item.stringOrNull("notes"),
            recoveryCodes = if (recoveryCodes.isEmpty()) null else recoveryCodes,
            deletedAt = item.stringOrNull("deletedAt"),
            useCount = item.longOrNull("useCount"),
            lastUsedAt = item.stringOrNull("lastUsedAt"),
        )
    }

    /** Web 版と同じ並びと省略（devices は空なら書かない）。 */
    fun serialize(data: VaultData): String {
        val out = JsonObject()
        out.add("accounts", gson.toJsonTree(data.accounts))
        out.add("tombstones", gson.toJsonTree(data.tombstones ?: emptyList<Tombstone>()))
        val devices = data.devices.orEmpty()
        if (devices.isNotEmpty()) out.add("devices", gson.toJsonTree(devices))
        return gson.toJson(out)
    }

    /** 保存するときの並び（ピン → order → createdAt）。 */
    fun manualSort(accounts: List<Account>): List<Account> =
        accounts.sortedWith(
            compareBy<Account> { if (it.pinned) 0 else 1 }
                .thenBy { it.order }
                .thenBy { it.createdAt },
        )

    fun nextOrder(accounts: List<Account>): Int =
        (accounts.maxOfOrNull { it.order } ?: -1) + 1
}

/** JSON の値が文字列なら取り出す（数値などは null）。 */
fun JsonObject.stringOrNull(key: String): String? {
    val element = get(key) ?: return null
    if (!element.isJsonPrimitive) return null
    val primitive = element.asJsonPrimitive
    return if (primitive.isString) primitive.asString else null
}

/** JSON の値が整数なら取り出す（小数・文字列は null）。 */
fun JsonObject.intOrNull(key: String): Int? = longOrNull(key)?.let { value ->
    if (value in Int.MIN_VALUE..Int.MAX_VALUE) value.toInt() else null
}

fun JsonObject.longOrNull(key: String): Long? {
    val element = get(key) ?: return null
    if (!element.isJsonPrimitive) return null
    val primitive = element.asJsonPrimitive
    if (!primitive.isNumber) return null
    // Double を経由すると 2^53 を超える整数が丸まるので、Long として直接読む。
    return try {
        primitive.asLong
    } catch (_: NumberFormatException) {
        null
    }
}

/** 読み込んだ値の型揺れを吸収する。 */
fun Account.normalized(): Account = copy(
    type = if (type == "hotp") "hotp" else "totp",
    algorithm = when (algorithm.uppercase().replace("-", "")) {
        "SHA256" -> "SHA256"
        "SHA512" -> "SHA512"
        else -> "SHA1"
    },
    digits = if (digits == 8) 8 else 6,
    period = if (period in 1..300) period else 30,
    counter = if (counter < 0) 0 else counter,
    issuer = issuer.trim(),
    label = label.trim(),
)
