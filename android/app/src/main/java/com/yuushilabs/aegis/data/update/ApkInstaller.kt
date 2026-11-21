package com.yuushilabs.aegis.data.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File

/** ダウンロードした APK をシステムのインストーラに渡す口（テストで差し替えられる）。 */
interface ApkInstaller {

    /** 「提供元不明のアプリ」をこのアプリに許可済みか（`REQUEST_INSTALL_PACKAGES`）。 */
    fun canInstallPackages(): Boolean

    /** その許可を切り替える設定画面。 */
    fun unknownSourcesSettingsIntent(): Intent

    /** [apk] を開くインストーラの Intent（FileProvider 経由の読み取り許可つき）。 */
    fun installIntent(apk: File): Intent
}

class AndroidApkInstaller(private val context: Context) : ApkInstaller {

    override fun canInstallPackages(): Boolean =
        context.packageManager.canRequestPackageInstalls()

    override fun unknownSourcesSettingsIntent(): Intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
            data = Uri.parse("package:${context.packageName}")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

    override fun installIntent(apk: File): Intent {
        val uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            apk,
        )
        return Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }
}
