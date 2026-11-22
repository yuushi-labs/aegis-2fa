package com.yuushilabs.zekey.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.yuushilabs.zekey.BuildConfig
import com.yuushilabs.zekey.core.Account
import com.yuushilabs.zekey.core.AppLogin
import com.yuushilabs.zekey.core.AppLoginException
import com.yuushilabs.zekey.core.Migration
import com.yuushilabs.zekey.core.MigrationEntry
import com.yuushilabs.zekey.core.SyncCode
import com.yuushilabs.zekey.core.update.HttpApkDownloader
import com.yuushilabs.zekey.core.update.HttpReleaseFetcher
import com.yuushilabs.zekey.data.ZekeySettings
import com.yuushilabs.zekey.data.RepoEvent
import com.yuushilabs.zekey.data.SyncState
import com.yuushilabs.zekey.data.VaultRepository
import com.yuushilabs.zekey.data.update.AndroidApkInstaller
import com.yuushilabs.zekey.data.update.PrefsUpdateMemo
import com.yuushilabs.zekey.data.update.UpdateRepository
import com.yuushilabs.zekey.ui.update.UpdateController
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File
import java.util.UUID

sealed interface Route {
    data object Accounts : Route
    data object Settings : Route
    data object Add : Route
    data class Detail(val id: String) : Route
    data object Trash : Route
    data object Sync : Route
    data object Devices : Route
    data object Profiles : Route
}

/**
 * 画面の状態と操作の入口。UI はここだけを見る。
 */
class ZekeyViewModel(application: Application) : AndroidViewModel(application) {
    val repository = VaultRepository(application)

    /**
     * GitHub Releases からのアプリ内アップデート。画面を移動してもダウンロードが
     * 続くよう、ViewModel（プロセスと同じ寿命）に 1 つだけ置く。
     */
    val updateController = UpdateController(
        repository = UpdateRepository(
            fetcher = HttpReleaseFetcher(),
            downloader = HttpApkDownloader(),
            memo = PrefsUpdateMemo(application),
            apkDirectory = File(application.cacheDir, "updates"),
            currentVersionName = BuildConfig.VERSION_NAME,
            currentVersionCode = BuildConfig.VERSION_CODE,
        ),
        installer = AndroidApkInstaller(application),
        scope = viewModelScope,
    )

    val state: StateFlow<com.yuushilabs.zekey.data.RepoState> = repository.state

    private val _route = MutableStateFlow<Route>(Route.Accounts)
    val route: StateFlow<Route> = _route.asStateFlow()

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message.asStateFlow()

    private val _syncPrefill = MutableStateFlow("")
    val syncPrefill: StateFlow<String> = _syncPrefill.asStateFlow()

    private val _pendingAppLogin = MutableStateFlow<String?>(null)
    val pendingAppLogin: StateFlow<String?> = _pendingAppLogin.asStateFlow()

    init {
        viewModelScope.launch {
            repository.state.collect { current ->
                when (val event = current.event) {
                    is RepoEvent.Message -> _message.value = event.text
                    is RepoEvent.AppLoginDone -> _message.value = "サイトから「${event.vaultName}」を引き継ぎました"
                    is RepoEvent.AppLoginFailed -> _message.value = event.reason
                    null -> Unit
                }
                if (current.event != null) repository.consumeEvent()
            }
        }
    }

    fun navigate(route: Route) {
        repository.touch()
        _route.value = route
    }

    fun back() {
        _route.value = Route.Accounts
    }

    fun clearMessage() {
        _message.value = null
    }

    fun showMessage(text: String) {
        _message.value = text
    }

    fun touch() = repository.touch()

    // ------------------------------------------------------------------ 初期化

    fun setup(password: String, confirm: String, vaultName: String, enableSync: Boolean) {
        if (password != confirm) {
            _message.value = "パスワードが一致しません"
            return
        }
        viewModelScope.launch {
            try {
                repository.createVault(password, vaultName, enableSync)
                _message.value = if (enableSync) "ボルトを作成し、同期を有効にしました" else "ローカルのボルトを作成しました"
            } catch (error: Exception) {
                _message.value = error.message ?: "ボルトを作成できませんでした"
            }
        }
    }

    fun unlock(password: String) {
        viewModelScope.launch {
            repository.unlock(password).onFailure { _message.value = it.message }
        }
    }

    fun lock() {
        viewModelScope.launch { repository.lock() }
    }

    fun onBackground() = repository.onAppBackground()

    // ------------------------------------------------------------- アカウント

    fun addAccount(account: Account, force: Boolean = false) {
        viewModelScope.launch {
            if (!force) {
                val duplicates = repository.findDuplicates(account)
                if (duplicates.isNotEmpty()) {
                    _message.value = "同じアカウントがあります: " +
                        duplicates.joinToString(" / ") { it.account.displayName }
                    return@launch
                }
            }
            val result = repository.addAccount(account)
            result.onSuccess {
                _route.value = Route.Accounts
                _message.value = "アカウントを追加しました"
            }.onFailure { _message.value = it.message }
        }
    }

    fun addAccountsFromMigration(entries: List<MigrationEntry>) {
        if (entries.isEmpty()) return
        viewModelScope.launch {
            val now = com.yuushilabs.zekey.core.IsoTime.now()
            var order = repository.state.value.accounts.size
            val accounts = entries.map { entry ->
                Migration.entryToAccount(entry, UUID.randomUUID().toString(), now, order++)
            }
            val added = repository.addAccounts(accounts)
            _route.value = Route.Accounts
            _message.value = "${added}件を取り込みました" +
                if (added < entries.size) "（${entries.size - added}件は重複でスキップ）" else ""
        }
    }

    fun addAccountsFromOtpauth(uris: List<String>): Int {
        val accounts = ArrayList<Account>()
        for (uri in uris) {
            runCatching {
                val params = com.yuushilabs.zekey.core.Otpauth.parse(uri)
                accounts.add(com.yuushilabs.zekey.core.Otpauth.toAccountDraft(params))
            }
        }
        if (accounts.isEmpty()) return 0
        viewModelScope.launch {
            val now = com.yuushilabs.zekey.core.IsoTime.now()
            var order = repository.state.value.accounts.size
            repository.addAccounts(
                accounts.map { it.copy(id = UUID.randomUUID().toString(), createdAt = now, updatedAt = now, order = order++) },
            )
        }
        return accounts.size
    }

    fun updateAccount(account: Account) {
        viewModelScope.launch {
            repository.updateAccount(account).onSuccess {
                _route.value = Route.Accounts
                _message.value = "保存しました"
            }.onFailure { _message.value = it.message }
        }
    }

    fun trash(id: String) {
        viewModelScope.launch {
            repository.trashAccount(id)
            if (_route.value is Route.Detail) _route.value = Route.Accounts
            _message.value = "ゴミ箱に移しました（30日間は復元できます）"
        }
    }

    fun restore(id: String) {
        viewModelScope.launch {
            repository.restoreAccount(id)
            _message.value = "復元しました"
        }
    }

    fun purge(id: String) {
        viewModelScope.launch {
            repository.purgeAccount(id)
            _message.value = "完全に削除しました"
        }
    }

    fun emptyTrash() {
        viewModelScope.launch {
            repository.emptyTrash()
            _message.value = "ゴミ箱を空にしました"
        }
    }

    fun recordUse(id: String) {
        viewModelScope.launch { repository.recordUse(id) }
    }

    fun advanceHotp(id: String) {
        viewModelScope.launch {
            repository.advanceHotp(id)
            _message.value = "次のコードに進みました"
        }
    }

    fun togglePin(id: String) {
        viewModelScope.launch { repository.togglePin(id) }
    }

    fun account(id: String): Account? = state.value.accounts.firstOrNull { it.id == id }

    // -------------------------------------------------------------------- 同期

    fun setSyncPrefill(value: String) {
        _syncPrefill.value = value
    }

    fun attachSync(input: String) {
        val token = SyncCode.extract(input)
        if (token == null) {
            _message.value = "同期コードの形式が正しくありません"
            return
        }
        viewModelScope.launch {
            repository.attachSync(token).onSuccess {
                _route.value = Route.Accounts
                _message.value = "同期に接続しました。マスターパスワードで解錠してください"
            }.onFailure { _message.value = it.message }
        }
    }

    fun syncNow() {
        viewModelScope.launch {
            repository.syncNow().onFailure {
                _message.value = "同期できませんでした（通信を確認してください）"
            }
            if (repository.state.value.syncState == SyncState.SYNCED) {
                _message.value = "同期しました"
            }
        }
    }

    fun resolveConflict(mode: String) {
        viewModelScope.launch {
            repository.resolveConflict(mode).onSuccess { (added, updated) ->
                _message.value = when (mode) {
                    "discard" -> "サーバーの内容に合わせました"
                    "merge" -> "マージしました（追加 ${added} / 更新 ${updated}）"
                    else -> "この端末の内容で上書きしました"
                }
            }.onFailure { _message.value = it.message }
        }
    }

    fun disableSync() {
        viewModelScope.launch {
            repository.disableSync()
            _message.value = "同期を解除しました（この端末の記録は残ります）"
        }
    }

    // ---------------------------------------------------------------- 設定

    fun updateSettings(transform: (ZekeySettings) -> ZekeySettings) {
        repository.setSettings(transform(state.value.settings))
    }

    fun renameDevice(name: String) {
        viewModelScope.launch { repository.renameDevice(name) }
    }

    fun forgetDevice(id: String) {
        viewModelScope.launch { repository.forgetDevice(id) }
    }

    fun changePassword(current: String, next: String, confirm: String) {
        if (next != confirm) {
            _message.value = "新しいパスワードが一致しません"
            return
        }
        viewModelScope.launch {
            repository.unlock(current).onFailure {
                _message.value = it.message
                return@launch
            }
            repository.changePassword(next).onSuccess {
                _message.value = "パスワードを変更しました"
            }.onFailure { _message.value = it.message }
        }
    }

    fun createProfile(name: String, password: String) {
        viewModelScope.launch {
            repository.createProfile(name, password).onSuccess {
                _message.value = "ボルトを作成しました（新しいパスワードで解錠してください）"
            }.onFailure { _message.value = it.message }
        }
    }

    fun switchProfile(id: String) {
        viewModelScope.launch {
            repository.switchProfile(id)
            _route.value = Route.Accounts
        }
    }

    fun renameProfile(id: String, name: String) {
        viewModelScope.launch { repository.renameProfile(id, name) }
    }

    fun deleteProfile(id: String) {
        viewModelScope.launch {
            repository.deleteProfile(id).onFailure { _message.value = it.message }
        }
    }

    // ----------------------------------------------------------- サイト連携

    fun handleDeepLink(uri: String) {
        if (AppLogin.isAppLoginLink(uri)) {
            handleAppLogin(uri)
            return
        }
        val token = SyncCode.extractFromUrl(uri)
        if (token != null) {
            _syncPrefill.value = token
            _route.value = Route.Sync
        }
    }

    fun handleAppLogin(uri: String) {
        viewModelScope.launch {
            try {
                val payload = AppLogin.parse(uri)
                repository.handleAppLogin(payload).onSuccess {
                    _route.value = Route.Accounts
                }.onFailure { error ->
                    _message.value = error.message ?: "サイトから引き継げませんでした"
                }
            } catch (error: AppLoginException) {
                _message.value = error.message ?: "リンクを読み取れませんでした"
            }
        }
    }
}
