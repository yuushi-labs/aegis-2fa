package com.yuushilabs.aegis.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.google.gson.Gson
import com.yuushilabs.aegis.core.VaultEnvelope
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** 端末内のボルト記録。平文の秘密鍵は保存しない（封筒だけ）。 */
data class StoredVault(
    val id: String = "main",
    val name: String = "メイン",
    val createdAt: String = "",
    val envelope: VaultEnvelope? = null,
    /** 同期トークン。null ならローカル完結。 */
    val token: String? = null,
    /** 最後にサーバーと一致した revision。null は未同期。 */
    val syncedRevision: Int? = null,
    /** 生体認証で開けるようにラップした DEK。 */
    val biometricWrap: WrappedKey? = null,
)

data class WrappedKey(
    val iv: String = "",
    val ciphertext: String = "",
)

data class StoredState(
    val version: Int = 1,
    val activeVaultId: String = "main",
    val vaults: List<StoredVault> = emptyList(),
)

/**
 * ボルト記録の保存先。ファイル全体を Android Keystore の AES-256-GCM 鍵で暗号化する。
 * 鍵は Keystore の中にあり、アプリのファイルをコピーしても復号できない。
 */
class SecureStore(private val context: Context) {
    private val file = File(context.filesDir, "vault-store.bin")
    private val gson = Gson()

    fun exists(): Boolean = file.exists() && file.length() > 0

    fun load(): StoredState? {
        if (!exists()) return null
        return try {
            val bytes = file.readBytes()
            val bundle = SecureStoreFile.read(bytes) ?: return null
            val plaintext = KeystoreCrypto.decrypt(ALIAS, bundle.first, bundle.second)
            gson.fromJson(String(plaintext, Charsets.UTF_8), StoredState::class.java)
                ?.let { normalize(it) }
        } catch (_: Exception) {
            null
        }
    }

    fun save(state: StoredState) {
        val plaintext = gson.toJson(state).toByteArray(Charsets.UTF_8)
        val (iv, ciphertext) = KeystoreCrypto.encrypt(ALIAS, plaintext)
        val bytes = SecureStoreFile.write(iv, ciphertext)
        val temp = File(file.parentFile, "${file.name}.tmp")
        temp.writeBytes(bytes)
        if (!temp.renameTo(file)) {
            file.writeBytes(bytes)
            temp.delete()
        }
    }

    fun clear() {
        file.delete()
    }

    private fun normalize(state: StoredState): StoredState {
        val vaults = state.vaults.filter { it.id.isNotEmpty() }
        val active = if (vaults.any { it.id == state.activeVaultId }) {
            state.activeVaultId
        } else {
            vaults.firstOrNull()?.id ?: "main"
        }
        return state.copy(vaults = vaults, activeVaultId = active)
    }

    companion object {
        /** 保存ファイルを復号する鍵（端末の Keystore 内、アプリ専用）。 */
        private const val ALIAS = "aegis-store-key-v1"
    }
}

/** ファイル形式: MAGIC(4) + IV 長(1) + IV + 暗号文。 */
private object SecureStoreFile {
    private val MAGIC = byteArrayOf(0x41, 0x47, 0x53, 0x31) // "AGS1"

    fun write(iv: ByteArray, ciphertext: ByteArray): ByteArray {
        val out = ByteArray(MAGIC.size + 1 + iv.size + ciphertext.size)
        MAGIC.copyInto(out, 0)
        out[MAGIC.size] = iv.size.toByte()
        iv.copyInto(out, MAGIC.size + 1)
        ciphertext.copyInto(out, MAGIC.size + 1 + iv.size)
        return out
    }

    fun read(bytes: ByteArray): Pair<ByteArray, ByteArray>? {
        if (bytes.size < MAGIC.size + 1) return null
        for (index in MAGIC.indices) if (bytes[index] != MAGIC[index]) return null
        val ivLength = bytes[MAGIC.size].toInt() and 0xff
        val ivStart = MAGIC.size + 1
        val dataStart = ivStart + ivLength
        if (ivLength <= 0 || dataStart > bytes.size) return null
        return bytes.copyOfRange(ivStart, dataStart) to bytes.copyOfRange(dataStart, bytes.size)
    }
}

/** Android Keystore の AES-GCM。通常用と生体認証用の 2 種類を作る。 */
object KeystoreCrypto {
    private const val KEYSTORE = "AndroidKeyStore"
    const val BIOMETRIC_ALIAS = "aegis-biometric-key-v1"

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    fun getOrCreate(alias: String, requireUserAuthentication: Boolean = false): SecretKey {
        val store = keyStore()
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        val builder = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
        if (requireUserAuthentication) {
            builder.setUserAuthenticationRequired(true)
            builder.setInvalidatedByBiometricEnrollment(false)
        }
        generator.init(builder.build())
        return generator.generateKey()
    }

    fun encrypt(alias: String, plaintext: ByteArray): Pair<ByteArray, ByteArray> {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        // 生体認証用の鍵は、認証済みの Cipher を渡してもらう（ここでは通常鍵だけを扱う）。
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreate(alias))
        val iv = cipher.iv
        return iv to cipher.doFinal(plaintext)
    }

    fun decrypt(alias: String, iv: ByteArray, ciphertext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, getOrCreate(alias), GCMParameterSpec(128, iv))
        return cipher.doFinal(ciphertext)
    }

    /** 生体認証用の Cipher（暗号化）。BiometricPrompt で認証してから [wrapWithBiometricCipher] する。 */
    fun biometricEncryptCipher(): Cipher {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreate(BIOMETRIC_ALIAS, requireUserAuthentication = true))
        return cipher
    }

    /** 認証済みの Cipher で DEK をラップする。 */
    fun wrapWithBiometricCipher(cipher: Cipher, plaintext: ByteArray): Pair<ByteArray, ByteArray> =
        cipher.iv to cipher.doFinal(plaintext)

    /** 生体認証用の Cipher（復号）。IV を先に決めておく必要がある。 */
    fun biometricDecryptCipher(iv: ByteArray): Cipher {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            getOrCreate(BIOMETRIC_ALIAS, requireUserAuthentication = true),
            GCMParameterSpec(128, iv),
        )
        return cipher
    }

    /** 認証済みの Cipher でラップされた DEK を開ける。 */
    fun unwrapWithBiometricCipher(cipher: Cipher, ciphertext: ByteArray): ByteArray =
        cipher.doFinal(ciphertext)

    fun hasBiometricKey(): Boolean = try {
        keyStore().containsAlias(BIOMETRIC_ALIAS)
    } catch (_: Exception) {
        false
    }
}
