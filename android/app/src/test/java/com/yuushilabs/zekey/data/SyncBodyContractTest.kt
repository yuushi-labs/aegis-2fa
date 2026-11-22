package com.yuushilabs.zekey.data

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.yuushilabs.zekey.core.Crypto
import com.yuushilabs.zekey.core.VaultData
import com.yuushilabs.zekey.core.VaultJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `PUT` の body が、サーバーの検証（PHP 版 `deploy/xserver/site/app/src/Validation.php`、
 * Node 版 `server/routes/vault.ts` の zod）と同じキーだけを持つことを確かめる。
 *
 * サーバーは両方とも **未知のキーを拒否**する（strict）ので、キーが 1 つ増えるだけで
 * `400 invalid_body` になる。ここでは
 *  - ルートは `envelope` と `revision` の 2 つだけ
 *  - `envelope` は format / version / kdf / wrappedKey / data / verifier / revision / updatedAt の 8 つだけ
 *  - `kdf` は name / iterations / salt、`wrappedKey` と `data` は iv / ciphertext の 2 つだけ
 *  - 型と範囲（iterations 100,000〜1,000,000、文字列長）が検証を通る
 * を実際の封筒で検査する。
 */
class SyncBodyContractTest {

    private fun envelope() = Crypto.createEnvelope(
        password = "contract test password",
        plaintext = VaultJson.serialize(VaultData(emptyList(), emptyList())),
        revision = 7,
        iterations = Crypto.MIN_KDF_ITERATIONS,
        updatedAt = "2026-11-21T12:00:00.000Z",
    )

    private fun JsonObject.keys(): Set<String> = keySet().toSet()

    @Test
    fun `put body has exactly the fields the server validates`() {
        val root = SyncBodies.putBodyJson(envelope(), 6)

        assertEquals(setOf("envelope", "revision"), root.keys())
        assertEquals(6, root.get("revision").asInt)

        val body = root.getAsJsonObject("envelope")
        assertEquals(
            setOf("format", "version", "kdf", "wrappedKey", "data", "verifier", "revision", "updatedAt"),
            body.keys(),
        )
        assertEquals("aegis-vault", body.get("format").asString)
        assertEquals(1, body.get("version").asInt)
        assertEquals(7, body.get("revision").asInt)

        val kdf = body.getAsJsonObject("kdf")
        assertEquals(setOf("name", "iterations", "salt"), kdf.keys())
        assertEquals("PBKDF2-SHA256", kdf.get("name").asString)
        assertTrue(kdf.get("iterations").asInt in 100_000..1_000_000)
        assertTrue(kdf.get("salt").asString.isNotEmpty())
        assertTrue(kdf.get("salt").asString.length <= 64)

        for (name in listOf("wrappedKey", "data")) {
            val cipher = body.getAsJsonObject(name)
            assertEquals(setOf("iv", "ciphertext"), cipher.keys())
            assertTrue(cipher.get("iv").asString.isNotEmpty())
            assertTrue(cipher.get("iv").asString.length <= 64)
            assertTrue(cipher.get("ciphertext").asString.isNotEmpty())
            assertTrue(cipher.get("ciphertext").asString.length <= 200_000)
        }

        assertTrue(body.get("verifier").asString.isNotEmpty())
        assertTrue(body.get("verifier").asString.length <= 64)
        assertTrue(body.get("updatedAt").asString.isNotEmpty())
        assertTrue(body.get("updatedAt").asString.length <= 64)
    }

    @Test
    fun `put body serialises to the same numbers as integers`() {
        val text = SyncBodies.putBody(envelope(), 6)
        val parsed = JsonParser.parseString(text).asJsonObject
        assertTrue(parsed.get("revision").asJsonPrimitive.isNumber)
        assertTrue(parsed.getAsJsonObject("envelope").get("revision").asJsonPrimitive.isNumber)
        assertTrue(parsed.getAsJsonObject("envelope").getAsJsonObject("kdf").get("iterations").asJsonPrimitive.isNumber)
        assertNotNull(parsed.getAsJsonObject("envelope").get("verifier"))
    }

    @Test
    fun `revision zero is allowed by the schema but the engine never sends it as next revision`() {
        // スキーマ自体は revision 0 を許す（envelope.revision は 0 以上）。400 になるのは
        // 「次の revision が base 以下」のときだけなので、送る前に engine が進める。
        val zero = envelope().copy(revision = 0)
        val root = SyncBodies.putBodyJson(zero, 0)
        assertEquals(0, root.getAsJsonObject("envelope").get("revision").asInt)
        assertEquals(0, root.get("revision").asInt)
    }
}
