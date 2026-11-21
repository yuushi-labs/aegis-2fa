package com.yuushilabs.aegis.core.update

import com.google.gson.JsonObject
import com.google.gson.JsonParser

/** リリースに添付されたファイル 1 つ。 */
data class ReleaseAsset(
    val name: String,
    val downloadUrl: String,
    val sizeBytes: Long,
    /** GitHub が返す `sha256:...`（古いリリースには無い）。 */
    val sha256: String? = null,
)

/** `GET /repos/{owner}/{repo}/releases/latest` の必要な部分だけ。 */
data class GithubRelease(
    val tagName: String?,
    val name: String?,
    val body: String?,
    val prerelease: Boolean,
    val draft: Boolean,
    val htmlUrl: String?,
    val assets: List<ReleaseAsset>,
)

/**
 * リリース文書の読み取り。Gson で書き、壊れた文書（404 の本文や HTML）は null にする
 * （例外は投げない: 更新確認の失敗でアプリを止めない）。
 */
object GithubReleaseJson {

    fun parse(text: String?): GithubRelease? {
        if (text.isNullOrBlank()) return null
        val root = try {
            JsonParser.parseString(text)
        } catch (_: Exception) {
            return null
        }
        if (!root.isJsonObject) return null
        return read(root.asJsonObject)
    }

    fun read(root: JsonObject): GithubRelease? {
        val assets = ArrayList<ReleaseAsset>()
        val rawAssets = root.get("assets")?.takeIf { it.isJsonArray }?.asJsonArray
        if (rawAssets != null) {
            for (element in rawAssets) {
                if (!element.isJsonObject) continue
                val item = element.asJsonObject
                val name = item.stringOrNull("name") ?: continue
                val url = item.stringOrNull("browser_download_url") ?: continue
                assets.add(
                    ReleaseAsset(
                        name = name,
                        downloadUrl = url,
                        sizeBytes = item.get("size")?.takeIf { it.isJsonPrimitive }?.asLong ?: 0L,
                        sha256 = item.stringOrNull("digest")?.removePrefix("sha256:")?.takeIf { it.isNotBlank() },
                    ),
                )
            }
        }
        val tagName = root.stringOrNull("tag_name")
        if (tagName.isNullOrBlank() && assets.isEmpty()) return null
        return GithubRelease(
            tagName = tagName,
            name = root.stringOrNull("name"),
            body = root.stringOrNull("body"),
            prerelease = root.get("prerelease")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false,
            draft = root.get("draft")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false,
            htmlUrl = root.stringOrNull("html_url"),
            assets = assets,
        )
    }

    private fun JsonObject.stringOrNull(key: String): String? {
        val element = get(key) ?: return null
        if (!element.isJsonPrimitive) return null
        return if (element.asJsonPrimitive.isString) element.asString else null
    }
}
