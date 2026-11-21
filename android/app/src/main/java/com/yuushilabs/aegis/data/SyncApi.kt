package com.yuushilabs.aegis.data

import com.google.gson.JsonParser
import com.yuushilabs.aegis.core.VaultEnvelope
import com.yuushilabs.aegis.core.VaultJson
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/** 接続先はハードコード（設定でサーバー URL を変える UI は作らない）。 */
object ServerConfig {
    const val BASE_URL = "https://yuushi0911.xsrv.jp/aegis"
    const val API_PREFIX = "$BASE_URL/api/vault"
    const val HEALTH_URL = "$BASE_URL/api/health"
    const val APP_NAME = "Aegis 2FA"
}

class SyncHttpException(val status: Int) : Exception("sync request failed: $status")
class SyncConflictException(val currentRevision: Int) : Exception("sync conflict")
class SyncNotFoundException : Exception("vault not found")

/**
 * 同期 API クライアント。送るのは暗号文封筒だけ（Web 版 `src/lib/syncClient.ts` と同じ）。
 * `Authorization: Bearer <token>`、`PUT` の body は `{ envelope, revision }`。
 */
class SyncApi(
    private val baseUrl: String = ServerConfig.API_PREFIX,
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 30_000,
) {
    data class RemoteVault(val envelope: VaultEnvelope, val revision: Int)

    data class RemoteMeta(val revision: Int, val updatedAt: String)

    fun get(vaultId: String, token: String): RemoteVault {
        val response = request("GET", "$baseUrl/$vaultId", token, null)
        if (response.status == 404) throw SyncNotFoundException()
        if (response.status !in 200..299) throw SyncHttpException(response.status)
        val root = parse(response.body) ?: throw SyncHttpException(response.status)
        val envelopeJson = root.getAsJsonObject("envelope")
            ?: throw SyncHttpException(response.status)
        val envelope = VaultJson.readEnvelope(envelopeJson)
        val revision = root.get("revision")?.takeIf { it.isJsonPrimitive }?.asInt ?: envelope.revision
        return RemoteVault(envelope = envelope, revision = revision)
    }

    fun getMeta(vaultId: String, token: String): RemoteMeta {
        val response = request("GET", "$baseUrl/$vaultId/meta", token, null)
        if (response.status == 404) throw SyncNotFoundException()
        if (response.status !in 200..299) throw SyncHttpException(response.status)
        val root = parse(response.body) ?: throw SyncHttpException(response.status)
        return RemoteMeta(
            revision = root.get("revision")?.asInt ?: 0,
            updatedAt = root.get("updatedAt")?.asString.orEmpty(),
        )
    }

    class PutResult(val revision: Int)

    fun put(vaultId: String, token: String, envelope: VaultEnvelope, baseRevision: Int): PutResult {
        val body = Yamlish.writePutBody(envelope, baseRevision)
        val response = request("PUT", "$baseUrl/$vaultId", token, body)
        if (response.status == 409) {
            val root = parse(response.body)
            throw SyncConflictException(root?.get("currentRevision")?.asInt ?: baseRevision)
        }
        if (response.status == 404) throw SyncNotFoundException()
        if (response.status !in 200..299) throw SyncHttpException(response.status)
        val root = parse(response.body)
        return PutResult(root?.get("revision")?.asInt ?: (baseRevision + 1))
    }

    fun remove(vaultId: String, token: String) {
        val response = request("DELETE", "$baseUrl/$vaultId", token, null)
        if (response.status == 404) return
        if (response.status !in 200..299) throw SyncHttpException(response.status)
    }

    fun isHealthy(): Boolean = try {
        val connection = URL(ServerConfig.HEALTH_URL).openConnection() as HttpURLConnection
        connection.connectTimeout = connectTimeoutMs
        connection.readTimeout = readTimeoutMs
        connection.requestMethod = "GET"
        val code = connection.responseCode
        connection.disconnect()
        code in 200..299
    } catch (_: Exception) {
        false
    }

    private data class Response(val status: Int, val body: String)

    private fun request(method: String, url: String, token: String, body: String?): Response {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            instanceFollowRedirects = false
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Accept", "application/json")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=UTF-8")
            }
        }
        try {
            if (body != null) {
                connection.outputStream.use { stream ->
                    stream.write(body.toByteArray(Charsets.UTF_8))
                }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
            return Response(status, text)
        } finally {
            connection.disconnect()
        }
    }

    private fun parse(body: String) = try {
        if (body.isBlank()) null else JsonParser.parseString(body).takeIf { it.isJsonObject }?.asJsonObject
    } catch (_: Exception) {
        null
    }

    /** PUT の body（`{ envelope, revision }`）。 */
    private object Yamlish {
        fun writePutBody(envelope: VaultEnvelope, revision: Int): String {
            val envelopeJson = VaultJson.gson.toJsonTree(envelope)
            val root = com.google.gson.JsonObject()
            root.add("envelope", envelopeJson)
            root.addProperty("revision", revision)
            return VaultJson.gson.toJson(root)
        }
    }
}
