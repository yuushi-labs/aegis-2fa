package com.yuushilabs.aegis.core

import com.google.gson.JsonParser
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Web 版（shared/crypto.ts）で作った封筒をこのアプリで開けることを確かめる互換テスト。
 * フィクスチャは node で `createVaultEnvelope` を実行して生成したもの。
 */
class CryptoCompatTest {
    private fun fixture(): com.google.gson.JsonObject {
        val stream = javaClass.getResourceAsStream("/web-envelope.json")
            ?: error("web-envelope.json がありません")
        return JsonParser.parseString(stream.bufferedReader().readText()).asJsonObject
    }

    @Test
    fun `opens a vault created by the web implementation`() {
        val json = fixture()
        val password = json.get("password").asString
        val expectedPlaintext = json.get("plaintext").asString
        val dek = Bytes.hexDecode(json.get("dekHex").asString)
        val envelope = VaultJson.readEnvelope(json.getAsJsonObject("envelope"))

        val unlocked = Crypto.unlock(envelope, password)
        assertEquals(expectedPlaintext, unlocked.plaintext)
        assertArrayEquals(dek, unlocked.dek)
        assertEquals(7, unlocked.revision)
        assertEquals(expectedPlaintext, Crypto.decryptWithDek(envelope, dek))
    }

    @Test
    fun `verifier matches the web implementation`() {
        val json = fixture()
        val dek = Bytes.hexDecode(json.get("dekHex").asString)
        val envelope = VaultJson.readEnvelope(json.getAsJsonObject("envelope"))
        assertTrue(Crypto.isVerifierMatch(envelope, dek))
        assertEquals(envelope.verifier, Bytes.base64(Crypto.computeVerifier(dek)))
    }

    @Test
    fun `data decrypted by this app is readable as the web VaultData shape`() {
        val json = fixture()
        val envelope = VaultJson.readEnvelope(json.getAsJsonObject("envelope"))
        val dek = Bytes.hexDecode(json.get("dekHex").asString)
        val data = VaultJson.parse(Crypto.decryptWithDek(envelope, dek))
        assertEquals(1, data.accounts.size)
        val account = data.accounts.first()
        assertEquals("GitHub", account.issuer)
        assertEquals("yuushi@example.com", account.label)
        assertEquals("JBSWY3DPEHPK3PXP", account.secret)
        assertTrue(account.pinned)
        assertEquals(3L, account.useCount)
        assertEquals("メモ", account.notes)
        assertEquals(1, account.recoveryCodes?.size)
        assertEquals("deadbeef", data.tombstones?.first()?.id)
        assertEquals("device-1", data.devices?.first()?.id)
    }

    @Test
    fun `round trip`() {
        val envelope = Crypto.createEnvelope("correct horse battery staple", """{"accounts":[]}""", revision = 3)
        val unlocked = Crypto.unlock(envelope, "correct horse battery staple")
        assertEquals("""{"accounts":[]}""", unlocked.plaintext)
        assertEquals(3, unlocked.revision)
    }

    @Test
    fun `wrong password fails`() {
        val envelope = Crypto.createEnvelope("correct horse battery staple", "{}")
        assertThrows(Crypto.WrongPasswordException::class.java) {
            Crypto.unlock(envelope, "wrong password 1234")
        }
        assertFalse(Crypto.verifyPassword(envelope, "wrong password 1234"))
        assertTrue(Crypto.verifyPassword(envelope, "correct horse battery staple"))
    }

    @Test
    fun `tampered ciphertext fails`() {
        val envelope = Crypto.createEnvelope("correct horse battery staple", """{"accounts":[]}""")
        val bytes = Bytes.base64Decode(envelope.data.ciphertext)
        bytes[0] = (bytes[0].toInt() xor 0x01).toByte()
        val tampered = envelope.copy(data = envelope.data.copy(ciphertext = Bytes.base64(bytes)))
        assertThrows(Crypto.WrongPasswordException::class.java) {
            Crypto.unlock(tampered, "correct horse battery staple")
        }
    }

    @Test
    fun `revision is part of the AAD`() {
        val envelope = Crypto.createEnvelope("correct horse battery staple", """{"accounts":[]}""", revision = 1)
        val moved = envelope.copy(revision = 2)
        assertThrows(Crypto.WrongPasswordException::class.java) {
            Crypto.unlock(moved, "correct horse battery staple")
        }
    }

    @Test
    fun `iv changes on every encryption`() {
        val first = Crypto.createEnvelope("correct horse battery staple", "{}")
        val second = Crypto.createEnvelope("correct horse battery staple", "{}")
        assertNotEquals(first.data.iv, second.data.iv)
        assertNotEquals(first.data.ciphertext, second.data.ciphertext)
        assertNotEquals(first.kdf.salt, second.kdf.salt)
    }

    @Test
    fun `update and rewrap keep the same dek`() {
        val dek = Crypto.generateDek()
        val envelope = Crypto.createEnvelope("correct horse battery staple", """{"accounts":[]}""", dek = dek)
        val updated = Crypto.updateEnvelopeData(envelope, dek, """{"accounts":[]}""", 2)
        assertEquals(2, updated.revision)
        assertEquals("""{"accounts":[]}""", Crypto.decryptWithDek(updated, dek))

        val rewrapped = Crypto.rewrapEnvelope(updated, dek, "a different master password")
        assertEquals("""{"accounts":[]}""", Crypto.unlock(rewrapped, "a different master password").plaintext)
        assertThrows(Crypto.WrongPasswordException::class.java) {
            Crypto.unlock(rewrapped, "correct horse battery staple")
        }
    }

    @Test
    fun `rejects excessive kdf iterations from an untrusted envelope`() {
        val envelope = Crypto.createEnvelope("correct horse battery staple", "{}")
        val hostile = envelope.copy(kdf = envelope.kdf.copy(iterations = 50_000_000))
        assertThrows(Crypto.CryptoException::class.java) {
            Crypto.unlock(hostile, "correct horse battery staple")
        }
        assertFalse(Crypto.isEnvelopeShape(hostile))
    }

    @Test
    fun `envelope shape validation`() {
        val envelope = Crypto.createEnvelope("correct horse battery staple", "{}")
        assertTrue(Crypto.isEnvelopeShape(envelope))
        assertFalse(Crypto.isEnvelopeShape(envelope.copy(format = "other")))
        assertFalse(Crypto.isEnvelopeShape(envelope.copy(verifier = "")))
    }
}
