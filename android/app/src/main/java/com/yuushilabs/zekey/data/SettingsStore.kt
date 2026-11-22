package com.yuushilabs.zekey.data

import android.content.Context
import com.yuushilabs.zekey.core.IsoTime
import java.util.UUID

/** 表示や使い勝手の設定。秘密情報ではないので SharedPreferences に平文で置く。 */
data class ZekeySettings(
    val autoLockMinutes: Int = 5,
    val lockOnHide: Boolean = true,
    val sortMode: String = "manual",
    val themeMode: String = "system",
    val clockSkew: Int = 0,
    val clearClipboard: Boolean = true,
    val biometricEnabled: Boolean = false,
    val deviceId: String = "",
    val deviceName: String = "Android",
)

class SettingsStore(private val context: Context) {
    private val prefs = context.getSharedPreferences("zekey-settings", Context.MODE_PRIVATE)

    fun load(): ZekeySettings {
        val deviceId = prefs.getString("deviceId", null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString("deviceId", it).apply()
        }
        return ZekeySettings(
            autoLockMinutes = prefs.getInt("autoLockMinutes", 5).coerceIn(0, 240),
            lockOnHide = prefs.getBoolean("lockOnHide", true),
            sortMode = prefs.getString("sortMode", "manual") ?: "manual",
            themeMode = prefs.getString("themeMode", "system") ?: "system",
            clockSkew = prefs.getInt("clockSkew", 0).coerceIn(-2, 2),
            clearClipboard = prefs.getBoolean("clearClipboard", true),
            biometricEnabled = prefs.getBoolean("biometricEnabled", false),
            deviceId = deviceId,
            deviceName = prefs.getString("deviceName", null) ?: defaultDeviceName(),
        )
    }

    fun save(settings: ZekeySettings) {
        prefs.edit()
            .putInt("autoLockMinutes", settings.autoLockMinutes)
            .putBoolean("lockOnHide", settings.lockOnHide)
            .putString("sortMode", settings.sortMode)
            .putString("themeMode", settings.themeMode)
            .putInt("clockSkew", settings.clockSkew)
            .putBoolean("clearClipboard", settings.clearClipboard)
            .putBoolean("biometricEnabled", settings.biometricEnabled)
            .putString("deviceName", settings.deviceName)
            .apply()
    }

    private fun defaultDeviceName(): String {
        val manufacturer = android.os.Build.MANUFACTURER.orEmpty().ifBlank { "Android" }
        val model = android.os.Build.MODEL.orEmpty()
        return if (model.isBlank() || model.equals("sdk", ignoreCase = true)) "$manufacturer (Android)"
        else "$manufacturer $model"
    }

    companion object {
        fun nowIso(): String = IsoTime.now()
    }
}
