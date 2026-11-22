package com.yuushilabs.zekey.core

import java.security.GeneralSecurityException
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * ゼロ知識ボルトの暗号処理。Web 版 `shared/crypto.ts` とバイト単位で互換。
 *
 * - KEK: PBKDF2-HMAC-SHA-256(iterations, salt 16B) → AES-256-GCM 鍵
 * - DEK: ランダム 32B。KEK で AES-256-GCM ラップ（IV 12B、AAD "aegis-vault-v1"）
 * - データ: DEK で AES-256-GCM（IV 12B、AAD "aegis-data-v1:<revision>"）
 * - verifier: HMAC-SHA-256(DEK, "aegis-verify-v1") の先頭 16B
 */
object Crypto {
    const val PBKDF2_ITERATIONS = 600_000
    const val MIN_KDF_ITERATIONS = 100_000
    const val MAX_KDF_ITERATIONS = 1_000_000
    const val MIN_PASSWORD_LENGTH = 12

    private const val VERIFIER_LENGTH = 16
    private const val SALT_LENGTH = 16
    private const val IV_LENGTH = 12
    private const val DEK_LENGTH = 32
    private const val TAG_BITS = 128

    private val WRAP_AAD = Bytes.utf8("aegis-vault-v1")
    private val VERIFY_MESSAGE = Bytes.utf8("aegis-verify-v1")

    open class CryptoException(message: String, cause: Throwable? = null) : Exception(message, cause)

    class WrongPasswordException : CryptoException("パスワードが違います")

    fun deriveKek(password: String, salt: ByteArray, iterations: Int = PBKDF2_ITERATIONS): SecretKey {
        if (password.isEmpty()) throw CryptoException("パスワードが空です")
        if (iterations < MIN_KDF_ITERATIONS) throw CryptoException("PBKDF2 の反復回数が少なすぎます")
        if (iterations > MAX_KDF_ITERATIONS) throw CryptoException("PBKDF2 の反復回数が多すぎます")
        val spec = PBEKeySpec(password.toCharArray(), salt, iterations, DEK_LENGTH * 8)
        return try {
            val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
            SecretKeySpec(factory.generateSecret(spec).encoded, "AES")
        } catch (error: GeneralSecurityException) {
            throw CryptoException("鍵を導出できません", error)
        } finally {
            spec.clearPassword()
        }
    }

    private fun aesGcmEncrypt(key: SecretKey, iv: ByteArray, plaintext: ByteArray, aad: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
        cipher.updateAAD(aad)
        return cipher.doFinal(plaintext)
    }

    private fun aesGcmDecrypt(key: SecretKey, iv: ByteArray, ciphertext: ByteArray, aad: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
        cipher.updateAAD(aad)
        return try {
            cipher.doFinal(ciphertext)
        } catch (error: AEADBadTagException) {
            throw WrongPasswordException()
        } catch (error: GeneralSecurityException) {
            throw WrongPasswordException()
        }
    }

    fun hmac(algorithm: String, key: ByteArray, message: ByteArray): ByteArray {
        val macName = when (algorithm.uppercase()) {
            "SHA256" -> "HmacSHA256"
            "SHA512" -> "HmacSHA512"
            else -> "HmacSHA1"
        }
        val mac = Mac.getInstance(macName)
        mac.init(SecretKeySpec(key, macName))
        return mac.doFinal(message)
    }

    fun generateDek(): ByteArray = Bytes.randomBytes(DEK_LENGTH)

    private fun importDek(dek: ByteArray): SecretKey {
        if (dek.size != DEK_LENGTH) throw CryptoException("DEK の長さが不正です")
        return SecretKeySpec(dek, "AES")
    }

    fun computeVerifier(dek: ByteArray): ByteArray =
        hmac("SHA256", dek, VERIFY_MESSAGE).copyOfRange(0, VERIFIER_LENGTH)

    private fun dataAad(revision: Int): ByteArray = Bytes.utf8("aegis-data-v1:$revision")

    fun isVerifierMatch(envelope: VaultEnvelope, dek: ByteArray): Boolean {
        val expected = try {
            Bytes.base64Decode(envelope.verifier)
        } catch (_: IllegalArgumentException) {
            return false
        }
        return Bytes.timingSafeEqual(expected, computeVerifier(dek))
    }

    /** 新しいボルト封筒を作る。 */
    fun createEnvelope(
        password: String,
        plaintext: String,
        revision: Int = 1,
        iterations: Int = PBKDF2_ITERATIONS,
        updatedAt: String = IsoTime.now(),
        dek: ByteArray? = null,
        salt: ByteArray? = null,
    ): VaultEnvelope {
        val key = dek ?: generateDek()
        if (key.size != DEK_LENGTH) throw CryptoException("DEK の長さが不正です")
        val actualSalt = salt ?: Bytes.randomBytes(SALT_LENGTH)
        val kek = deriveKek(password, actualSalt, iterations)
        val wrapIv = Bytes.randomBytes(IV_LENGTH)
        val wrappedKey = aesGcmEncrypt(kek, wrapIv, key, WRAP_AAD)

        val dataIv = Bytes.randomBytes(IV_LENGTH)
        val ciphertext = aesGcmEncrypt(importDek(key), dataIv, Bytes.utf8(plaintext), dataAad(revision))

        return VaultEnvelope(
            format = "zekey-vault",
            version = 1,
            kdf = VaultKdf("PBKDF2-SHA256", iterations, Bytes.base64(actualSalt)),
            wrappedKey = VaultCipher(Bytes.base64(wrapIv), Bytes.base64(wrappedKey)),
            data = VaultCipher(Bytes.base64(dataIv), Bytes.base64(ciphertext)),
            verifier = Bytes.base64(computeVerifier(key)),
            revision = revision,
            updatedAt = updatedAt,
        )
    }

    class UnlockedVault(val dek: ByteArray, val plaintext: String, val revision: Int)

    /** パスワードで封筒を開ける。誤りは [WrongPasswordException]。 */
    fun unlock(envelope: VaultEnvelope, password: String): UnlockedVault {
        val salt = Bytes.base64Decode(envelope.kdf.salt)
        val kek = deriveKek(password, salt, envelope.kdf.iterations)
        val dek = aesGcmDecrypt(
            kek,
            Bytes.base64Decode(envelope.wrappedKey.iv),
            Bytes.base64Decode(envelope.wrappedKey.ciphertext),
            WRAP_AAD,
        )
        if (!isVerifierMatch(envelope, dek)) throw WrongPasswordException()
        val plaintext = Bytes.fromUtf8(
            aesGcmDecrypt(
                importDek(dek),
                Bytes.base64Decode(envelope.data.iv),
                Bytes.base64Decode(envelope.data.ciphertext),
                dataAad(envelope.revision),
            ),
        )
        return UnlockedVault(dek, plaintext, envelope.revision)
    }

    /** アンロック中の DEK でデータ部だけを復号する（パスワード不要）。 */
    fun decryptWithDek(envelope: VaultEnvelope, dek: ByteArray): String {
        if (!isVerifierMatch(envelope, dek)) throw CryptoException("この封筒は別の鍵で暗号化されています")
        return Bytes.fromUtf8(
            aesGcmDecrypt(
                importDek(dek),
                Bytes.base64Decode(envelope.data.iv),
                Bytes.base64Decode(envelope.data.ciphertext),
                dataAad(envelope.revision),
            ),
        )
    }

    /** 封筒のデータ部を差し替える（revision を進める）。 */
    fun updateEnvelopeData(
        envelope: VaultEnvelope,
        dek: ByteArray,
        plaintext: String,
        revision: Int,
        updatedAt: String = IsoTime.now(),
    ): VaultEnvelope {
        val iv = Bytes.randomBytes(IV_LENGTH)
        val ciphertext = aesGcmEncrypt(
            importDek(dek),
            iv,
            Bytes.utf8(plaintext),
            dataAad(revision),
        )
        return envelope.copy(
            data = VaultCipher(Bytes.base64(iv), Bytes.base64(ciphertext)),
            verifier = Bytes.base64(computeVerifier(dek)),
            revision = revision,
            updatedAt = updatedAt,
        )
    }

    /** パスワード変更: 同じ DEK を新しいパスワードの KEK でラップし直す。 */
    fun rewrapEnvelope(
        envelope: VaultEnvelope,
        dek: ByteArray,
        newPassword: String,
        iterations: Int = envelope.kdf.iterations,
        updatedAt: String = IsoTime.now(),
    ): VaultEnvelope {
        val salt = Bytes.randomBytes(SALT_LENGTH)
        val kek = deriveKek(newPassword, salt, iterations)
        val wrapIv = Bytes.randomBytes(IV_LENGTH)
        val wrappedKey = aesGcmEncrypt(kek, wrapIv, dek, WRAP_AAD)
        return envelope.copy(
            kdf = VaultKdf("PBKDF2-SHA256", iterations, Bytes.base64(salt)),
            wrappedKey = VaultCipher(Bytes.base64(wrapIv), Bytes.base64(wrappedKey)),
            updatedAt = updatedAt,
        )
    }

    fun verifyPassword(envelope: VaultEnvelope, password: String): Boolean = try {
        unlock(envelope, password)
        true
    } catch (_: Exception) {
        false
    }

    /** 封筒の形の最低限の検査（サーバー側 zod と同程度）。 */
    fun isEnvelopeShape(envelope: VaultEnvelope?): Boolean {
        if (envelope == null) return false
        if (envelope.format != "zekey-vault" || envelope.version != 1) return false
        if (envelope.kdf.name != "PBKDF2-SHA256") return false
        if (envelope.kdf.iterations !in MIN_KDF_ITERATIONS..MAX_KDF_ITERATIONS) return false
        if (envelope.kdf.salt.isEmpty()) return false
        if (envelope.wrappedKey.iv.isEmpty() || envelope.wrappedKey.ciphertext.isEmpty()) return false
        if (envelope.data.iv.isEmpty() || envelope.data.ciphertext.isEmpty()) return false
        if (envelope.verifier.isEmpty()) return false
        if (envelope.revision < 0) return false
        return envelope.updatedAt.isNotEmpty()
    }
}
