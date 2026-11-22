package com.yuushilabs.zekey.core.update

/** 更新できるリリースの内容（画面に出す分だけ）。 */
data class UpdateInfo(
    /** 表示するバージョン（`1.1.2`）。 */
    val versionName: String,
    /** リリース本文に書かれた versionCode（あれば）。 */
    val versionCode: Int?,
    /** 変更点の要約（リリースノートの先頭数行）。 */
    val notes: String,
    val apkUrl: String,
    val apkFileName: String,
    val apkSizeBytes: Long,
    /** `sha256:...` が添付されていれば、ダウンロード後に照合する。 */
    val apkSha256: String?,
    val releaseUrl: String?,
)

/**
 * 「このリリースは今より新しいか」の判断。純粋な Kotlin なので、GitHub が実際に返す
 * 文書（`v1.1.2` タグと `zekey-android-v1.1.2.apk`）でテストできる。
 */
object UpdateDecision {

    /**
     * 提示する更新、無ければ null:
     * 同じ/古いバージョン、draft・prerelease、APK が添付されていないリリース。
     */
    fun decide(
        currentVersionName: String,
        currentVersionCode: Int,
        release: GithubRelease,
    ): UpdateInfo? {
        if (release.draft || release.prerelease) return null

        val apk = release.assets
            .filter { it.name.endsWith(".apk", ignoreCase = true) }
            .filter { it.downloadUrl.startsWith("https://") }
            .filter { it.sizeBytes == 0L || it.sizeBytes > MIN_APK_BYTES }
            // このアプリの APK を優先（zip などに .apk が混ざるリリースでも迷わない）。
            .sortedWith(
                compareByDescending<ReleaseAsset> { it.name.startsWith("zekey-", ignoreCase = true) }
                    .thenByDescending { it.sizeBytes },
            )
            .firstOrNull()
            ?: return null

        val declaredCode = declaredVersionCode(release.body)
        val releaseVersion = AppVersion.parse(release.tagName) ?: AppVersion.parse(release.name)
        val currentVersion = AppVersion.parse(currentVersionName)

        val newer = when {
            releaseVersion != null && currentVersion != null -> releaseVersion > currentVersion
            declaredCode != null -> declaredCode > currentVersionCode
            else -> false
        }
        if (!newer) return null

        return UpdateInfo(
            versionName = releaseVersion?.display
                ?: release.tagName?.removePrefix("v")
                ?: release.name
                ?: "build $declaredCode",
            versionCode = declaredCode,
            notes = summaryOf(release.body),
            apkUrl = apk.downloadUrl,
            apkFileName = apk.name,
            apkSizeBytes = apk.sizeBytes,
            apkSha256 = apk.sha256,
            releaseUrl = release.htmlUrl,
        )
    }

    /** リリース本文の `versionCode: 3` / `versionCode=3` / `versionCode 3`。 */
    fun declaredVersionCode(body: String?): Int? {
        val text = body ?: return null
        return Regex("""versionCode\s*[:=]?\s*(\d{1,9})""", RegexOption.IGNORE_CASE)
            .find(text)?.groupValues?.get(1)?.toIntOrNull()
    }

    /**
     * 変更点の要約。Markdown の飾りを落として先頭 [maxLines] 行に収める
     * （バージョン番号だけの見出しや versionCode の行は読む人に何も伝えないので除く）。
     */
    fun summaryOf(body: String?, maxLines: Int = MAX_NOTE_LINES, maxChars: Int = MAX_NOTE_CHARS): String {
        val lines = (body ?: "")
            .lineSequence()
            .map { it.trim() }
            .map { line ->
                line
                    .removePrefix(">")
                    .trim()
                    .trimStart('#', '-', '*', '+', ' ')
                    .replace(Regex("""\[([^\]]*)]\([^)]*\)"""), "$1")
                    .replace("**", "")
                    .replace("`", "")
                    .trim()
            }
            .filter { it.isNotEmpty() }
            .filterNot { it.matches(Regex("""v?\d+(\.\d+)*([- ]\w+)*""")) }
            .filterNot { it.matches(Regex("""(?i)versionCode\s*[:=]?\s*\d+""")) }
            .take(maxLines)
            .toList()
        val text = lines.joinToString("\n")
        return if (text.length <= maxChars) text else text.take(maxChars).trimEnd() + "…"
    }

    private const val MIN_APK_BYTES = 512L * 1024L
    private const val MAX_NOTE_LINES = 6
    private const val MAX_NOTE_CHARS = 400
}
