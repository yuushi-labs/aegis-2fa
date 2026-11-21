package com.yuushilabs.aegis.ui.update

import android.content.Intent
import android.util.Log
import com.yuushilabs.aegis.data.update.ApkInstaller
import com.yuushilabs.aegis.data.update.CheckOutcome
import com.yuushilabs.aegis.data.update.UpdateRepository
import com.yuushilabs.aegis.core.update.UpdateInfo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File

/** 一覧のバナーと設定の「アップデート」欄が表示する状態。 */
sealed interface UpdateUiState {

    /** まだ確認していない。 */
    data object Idle : UpdateUiState

    data object Checking : UpdateUiState

    /** 今が最新。 */
    data object Latest : UpdateUiState

    /**
     * 新しいリリースがある。[skipped] は「後で」を選んだ状態で、
     * 一覧のバナーは引っ込み、設定の欄にだけ残る。
     */
    data class Available(val info: UpdateInfo, val skipped: Boolean) : UpdateUiState

    data class Downloading(
        val info: UpdateInfo,
        val bytes: Long,
        val total: Long,
    ) : UpdateUiState {
        /** 全体の大きさが分からないときは null。 */
        val percent: Int?
            get() = if (total > 0) ((bytes * 100) / total).toInt().coerceIn(0, 100) else null
    }

    /** ダウンロード済み。画面がインストーラを開く。 */
    data class Ready(val info: UpdateInfo, val apk: File) : UpdateUiState

    /** [manual] の失敗だけ画面に出す（自動確認は静かにする）。 */
    data class Failed(val message: String, val manual: Boolean) : UpdateUiState
}

/**
 * 更新の確認・ダウンロード・インストーラ起動をつなぐ。
 * [com.yuushilabs.aegis.ui.AegisViewModel] に 1 つだけ持たせ、画面を移動しても
 * ダウンロードが続くようにしている。
 */
class UpdateController(
    private val repository: UpdateRepository,
    private val installer: ApkInstaller,
    private val scope: CoroutineScope,
) {

    private val _state = MutableStateFlow<UpdateUiState>(UpdateUiState.Idle)
    val state: StateFlow<UpdateUiState> = _state.asStateFlow()

    val currentVersionName: String get() = repository.currentVersionName

    private var work: Job? = null

    /** このプロセスで一度だけ、起動時に古い APK を掃除する。 */
    private var prunedThisLaunch = false

    /** 起動・フォアグラウンド復帰のたびに確認する（連打は 20 秒でまとめる）。 */
    fun onForeground() {
        val cleanup = !prunedThisLaunch
        prunedThisLaunch = true
        check(manual = false, cleanupFirst = cleanup)
    }

    fun checkNow() {
        check(manual = true)
    }

    private fun check(manual: Boolean, cleanupFirst: Boolean = false) {
        if (work?.isActive == true) return
        work = scope.launch {
            if (cleanupFirst) {
                try {
                    repository.pruneStaleApks()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Throwable) {
                    Log.i(TAG, "update cleanup skipped: ${error.message}")
                }
            }
            // 静かな再確認が、表示中の更新・ダウンロード・インストールを消さないようにする。
            val shown = _state.value
            val keepShown = !manual && when (shown) {
                is UpdateUiState.Available,
                is UpdateUiState.Downloading,
                is UpdateUiState.Ready,
                -> true

                else -> false
            }
            if (!keepShown) _state.value = UpdateUiState.Checking
            val outcome = try {
                repository.check(manual)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                CheckOutcome.Unavailable(error.message ?: "update check failed")
            }
            _state.value = when (outcome) {
                is CheckOutcome.Available -> UpdateUiState.Available(outcome.info, outcome.skipped)

                CheckOutcome.UpToDate -> UpdateUiState.Latest

                CheckOutcome.Throttled -> if (_state.value is UpdateUiState.Checking) {
                    UpdateUiState.Idle
                } else {
                    _state.value
                }

                is CheckOutcome.Unavailable -> {
                    Log.i(TAG, "update check unavailable: ${outcome.reason}")
                    if (keepShown) {
                        _state.value
                    } else {
                        UpdateUiState.Failed("アップデートを確認できませんでした", manual)
                    }
                }
            }
        }
    }

    /** 今すぐ更新: APK を落として進捗を出す。 */
    fun downloadNow() {
        val available = _state.value as? UpdateUiState.Available ?: return
        if (work?.isActive == true) return
        val info = available.info
        work = scope.launch {
            _state.value = UpdateUiState.Downloading(info, bytes = 0, total = info.apkSizeBytes)
            val result = repository.download(info) { bytes, total ->
                _state.value = UpdateUiState.Downloading(info, bytes, total)
            }
            _state.value = result.fold(
                onSuccess = { apk -> UpdateUiState.Ready(info, apk) },
                onFailure = { error ->
                    Log.w(TAG, "APK download failed", error)
                    UpdateUiState.Failed("ダウンロードできませんでした", manual = true)
                },
            )
        }
    }

    /** ダウンロードをやめて「更新があります」に戻す。 */
    fun cancelDownload() {
        val current = _state.value as? UpdateUiState.Downloading ?: return
        work?.cancel()
        work = null
        _state.value = UpdateUiState.Available(current.info, skipped = false)
    }

    /** 後で: 一覧のバナーを引っ込める（設定の欄には残る）。 */
    fun skip() {
        val available = _state.value as? UpdateUiState.Available ?: return
        _state.value = available.copy(skipped = true)
        scope.launch { repository.skip(available.info.versionName) }
    }

    fun canInstallPackages(): Boolean = installer.canInstallPackages()

    fun unknownSourcesSettingsIntent(): Intent = installer.unknownSourcesSettingsIntent()

    /**
     * ダウンロード済みの APK をインストーラへ渡す。
     * 「提供元不明のアプリ」が未許可なら null（画面が設定への案内を出す）。
     */
    fun installIntent(): Intent? {
        val ready = _state.value as? UpdateUiState.Ready ?: return null
        if (!canInstallPackages()) return null
        return installer.installIntent(ready.apk)
    }

    /**
     * インストーラを開いた（または利用者が離れた）。APK はインストーラが読み終えるまで
     * 残し、バナーだけ引っ込める。
     */
    fun installStarted() {
        val ready = _state.value as? UpdateUiState.Ready ?: return
        _state.value = UpdateUiState.Available(ready.info, skipped = true)
        scope.launch { repository.skip(ready.info.versionName) }
    }

    /** 設定から手動で確認し直すとき、失敗の表示を消す。 */
    fun dismissFailure() {
        if (_state.value is UpdateUiState.Failed) _state.value = UpdateUiState.Idle
    }

    private companion object {
        const val TAG = "UpdateController"
    }
}
