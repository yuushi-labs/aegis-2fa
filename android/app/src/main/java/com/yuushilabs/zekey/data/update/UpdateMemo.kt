package com.yuushilabs.zekey.data.update

import android.content.Context

/**
 * 更新確認の記憶: 最後に確認した時刻、GitHub の `ETag` と、そのときのリリース文書、
 * そして「後で」を選んだバージョン。
 *
 * ETag を覚えていると GitHub は 304（未変更）を返し、304 はレート制限
 * （未認証で 1 時間 60 回）に数えられない。だから起動・復帰のたびに確認してもよい。
 * 304 のときは保存してある文書を読み直すので、未インストールの更新は出続ける。
 */
interface UpdateMemo {
    suspend fun lastCheckedAt(): Long?

    suspend fun releaseEtag(): String?

    suspend fun releaseBody(): String?

    suspend fun skippedVersion(): String?

    suspend fun recordCheck(at: Long, etag: String? = null, body: String? = null)

    suspend fun skip(version: String)

    suspend fun clearSkip()
}

/** 秘密情報ではないので SharedPreferences（設定と同じ場所）に置く。 */
class PrefsUpdateMemo(context: Context) : UpdateMemo {
    private val prefs = context.getSharedPreferences("zekey-update", Context.MODE_PRIVATE)

    override suspend fun lastCheckedAt(): Long? =
        prefs.getLong(KEY_LAST_CHECKED, -1L).takeIf { it >= 0 }

    override suspend fun releaseEtag(): String? = prefs.getString(KEY_ETAG, null)

    override suspend fun releaseBody(): String? = prefs.getString(KEY_BODY, null)

    override suspend fun skippedVersion(): String? = prefs.getString(KEY_SKIPPED, null)

    override suspend fun recordCheck(at: Long, etag: String?, body: String?) {
        prefs.edit().apply {
            putLong(KEY_LAST_CHECKED, at)
            if (etag != null) putString(KEY_ETAG, etag)
            if (body != null) putString(KEY_BODY, body)
        }.apply()
    }

    override suspend fun skip(version: String) {
        prefs.edit().putString(KEY_SKIPPED, version).apply()
    }

    override suspend fun clearSkip() {
        prefs.edit().remove(KEY_SKIPPED).apply()
    }

    private companion object {
        const val KEY_LAST_CHECKED = "last_checked_at"
        const val KEY_ETAG = "release_etag"
        const val KEY_BODY = "release_body"
        const val KEY_SKIPPED = "skipped_version"
    }
}
