package com.yuushilabs.zekey.ui

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.yuushilabs.zekey.core.Bytes
import com.yuushilabs.zekey.data.KeystoreCrypto
import com.yuushilabs.zekey.ui.screens.AccountDetailScreen
import com.yuushilabs.zekey.ui.screens.AccountsScreen
import com.yuushilabs.zekey.ui.screens.AddAccountScreen
import com.yuushilabs.zekey.ui.screens.DevicesScreen
import com.yuushilabs.zekey.ui.screens.LockScreen
import com.yuushilabs.zekey.ui.screens.ProfilesScreen
import com.yuushilabs.zekey.ui.screens.SettingsScreen
import com.yuushilabs.zekey.ui.screens.SetupScreen
import com.yuushilabs.zekey.ui.screens.SyncScreen
import com.yuushilabs.zekey.ui.screens.TrashScreen
import com.yuushilabs.zekey.ui.screens.copyCode
import com.yuushilabs.zekey.ui.theme.ZekeyTheme
import kotlinx.coroutines.launch
import javax.crypto.Cipher

class MainActivity : FragmentActivity() {
    private val viewModel: ZekeyViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            ZekeyTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    ZekeyRoot(viewModel)
                }
            }
        }
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onStop() {
        super.onStop()
        viewModel.onBackground()
    }

    override fun onResume() {
        super.onResume()
        // 起動・フォアグラウンド復帰のたびに GitHub Releases を確認する（20 秒のデバウンス付き）。
        viewModel.updateController.onForeground()
    }

    /** ディープリンクを処理したら、Intent から値を消す（残さない）。 */
    private fun handleIntent(intent: Intent?) {
        val data = intent?.data?.toString() ?: return
        viewModel.handleDeepLink(data)
        intent.data = null
        intent.replaceExtras(null)
    }
}

private enum class BiometricMode { UNLOCK, ENROLL }

private class BiometricGate(
    val available: Boolean,
    val start: (Cipher) -> Unit,
)

@Composable
private fun rememberBiometricGate(
    onCipher: (Cipher) -> Unit,
    onError: (String) -> Unit,
): BiometricGate {
    val context = LocalContext.current
    val activity = context as? FragmentActivity
    val cipherCallback by rememberUpdatedState(onCipher)
    val errorCallback by rememberUpdatedState(onError)
    // CryptoObject を使う認証は BIOMETRIC_STRONG のみ（Class 2 の顔認証では鍵を解けない）。
    val available = remember {
        BiometricManager.from(context).canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_STRONG,
        ) == BiometricManager.BIOMETRIC_SUCCESS
    }
    val prompt = remember(activity) {
        activity?.let { host ->
            BiometricPrompt(
                host,
                ContextCompat.getMainExecutor(context),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        val cipher = result.cryptoObject?.cipher
                        if (cipher == null) errorCallback("生体認証を完了できませんでした") else cipherCallback(cipher)
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        errorCallback(errString.toString())
                    }
                },
            )
        }
    }
    val info = remember {
        BiometricPrompt.PromptInfo.Builder()
            .setTitle("Zekey 2FA")
            .setSubtitle("生体認証で解錠します")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setNegativeButtonText("キャンセル")
            .build()
    }
    return remember(prompt, available) {
        BiometricGate(available && prompt != null) { cipher ->
            prompt?.authenticate(info, BiometricPrompt.CryptoObject(cipher))
        }
    }
}

@Composable
fun ZekeyRoot(viewModel: ZekeyViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val route by viewModel.route.collectAsStateWithLifecycle()
    val message by viewModel.message.collectAsStateWithLifecycle()
    val syncPrefill by viewModel.syncPrefill.collectAsStateWithLifecycle()
    val updateState by viewModel.updateController.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var biometricMode by remember { mutableStateOf(BiometricMode.UNLOCK) }
    var installPermission by remember { mutableStateOf(false) }

    fun installUpdate() {
        val intent = viewModel.updateController.installIntent()
        if (intent == null) {
            installPermission = true
            return
        }
        runCatching { context.startActivity(intent) }
            .onFailure { viewModel.showMessage("インストーラを開けませんでした") }
        viewModel.updateController.installStarted()
    }

    LaunchedEffect(message) {
        val text = message ?: return@LaunchedEffect
        snackbar.showSnackbar(text)
        viewModel.clearMessage()
    }

    val biometric = rememberBiometricGate(
        onCipher = { cipher ->
            when (biometricMode) {
                BiometricMode.ENROLL -> scope.launch {
                    viewModel.repository.enrollBiometric(cipher)
                        .onSuccess { viewModel.showMessage("生体認証を登録しました") }
                        .onFailure { viewModel.showMessage(it.message ?: "登録できませんでした") }
                }
                BiometricMode.UNLOCK -> scope.launch {
                    viewModel.repository.unlockWithBiometric(cipher)
                        .onFailure { viewModel.showMessage(it.message ?: "生体認証で開けませんでした") }
                }
            }
        },
        onError = { viewModel.showMessage(it) },
    )

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            when {
                !state.loaded -> LoadingPane()
                !state.hasVault -> SetupScreen(
                    busy = state.busy,
                    onCreate = { password, confirm, name, sync -> viewModel.setup(password, confirm, name, sync) },
                )
                !state.unlocked -> LockScreen(
                    state = state,
                    busy = state.busy,
                    onUnlock = viewModel::unlock,
                    onBiometric = {
                        val wrap = viewModel.repository.biometricWrap()
                        if (wrap == null) {
                            viewModel.showMessage("生体認証が登録されていません")
                        } else {
                            biometricMode = BiometricMode.UNLOCK
                            runCatching {
                                biometric.start(KeystoreCrypto.biometricDecryptCipher(Bytes.base64Decode(wrap.iv)))
                            }.onFailure { viewModel.showMessage("生体認証を使えません") }
                        }
                    },
                    onSwitchProfile = viewModel::switchProfile,
                    biometricAvailable = biometric.available && state.biometricEnabled,
                )
                else -> {
                    BackHandler(enabled = route != Route.Accounts) { viewModel.navigate(Route.Accounts) }
                    when (val current = route) {
                        Route.Accounts -> AccountsScreen(
                            state = state,
                            route = route,
                            onNavigate = viewModel::navigate,
                            onCopy = { account ->
                                val code = com.yuushilabs.zekey.ui.screens.codeFor(
                                    account,
                                    System.currentTimeMillis() / 1000,
                                    state.settings.clockSkew,
                                )
                                copyCode(context, code, if (state.settings.clearClipboard) 30 else null)
                                viewModel.recordUse(account.id)
                                viewModel.showMessage("コピーしました")
                            },
                            onTogglePin = viewModel::togglePin,
                            onDelete = viewModel::trash,
                            onLock = viewModel::lock,
                            onSyncNow = viewModel::syncNow,
                            onResolveConflict = viewModel::resolveConflict,
                            onSortMode = { mode -> viewModel.updateSettings { it.copy(sortMode = mode) } },
                            onSwitchProfile = viewModel::switchProfile,
                            updateState = updateState,
                            onCheckUpdate = { viewModel.updateController.checkNow() },
                            onDownloadUpdate = { viewModel.updateController.downloadNow() },
                            onInstallUpdate = { installUpdate() },
                            onSkipUpdate = { viewModel.updateController.skip() },
                            onCancelUpdate = { viewModel.updateController.cancelDownload() },
                        )

                        Route.Add -> AddAccountScreen(
                            onBack = { viewModel.navigate(Route.Accounts) },
                            onCheckDuplicates = { draft -> viewModel.repository.findDuplicates(draft) },
                            onAdd = { account, force -> viewModel.addAccount(account, force) },
                            onMigrationImport = viewModel::addAccountsFromMigration,
                        )

                        is Route.Detail -> {
                            val account = viewModel.account(current.id)
                            if (account == null) {
                                LaunchedEffect(current.id) { viewModel.navigate(Route.Accounts) }
                            } else {
                                AccountDetailScreen(
                                    account = account,
                                    skew = state.settings.clockSkew,
                                    onBack = { viewModel.navigate(Route.Accounts) },
                                    onSave = viewModel::updateAccount,
                                    onCopy = { text ->
                                        // 秘密鍵を含む otpauth:// や復旧コードもコピーするので、一覧と同じ設定を適用する。
                                        copyCode(context, text, if (state.settings.clearClipboard) 30 else null)
                                        viewModel.showMessage("コピーしました")
                                    },
                                    onAdvanceHotp = viewModel::advanceHotp,
                                    onDelete = viewModel::trash,
                                    onRestore = viewModel::restore,
                                    onPurge = viewModel::purge,
                                )
                            }
                        }

                        Route.Settings -> SettingsScreen(
                            state = state,
                            onBack = { viewModel.navigate(Route.Accounts) },
                            onSettings = { transform -> viewModel.updateSettings(transform) },
                            onChangePassword = viewModel::changePassword,
                            onEnableBiometric = {
                                if (!biometric.available) {
                                    viewModel.showMessage("この端末では生体認証を使えません")
                                } else {
                                    biometricMode = BiometricMode.ENROLL
                                    runCatching { biometric.start(KeystoreCrypto.biometricEncryptCipher()) }
                                        .onFailure { viewModel.showMessage("生体認証を使えません") }
                                }
                            },
                            onDisableBiometric = {
                                scope.launch { viewModel.repository.disableBiometric() }
                            },
                            onSyncNow = viewModel::syncNow,
                            onDisableSync = viewModel::disableSync,
                            onEnableSync = { scope.launch { viewModel.repository.enableSync() } },
                            onOpenDevices = { viewModel.navigate(Route.Devices) },
                            onOpenProfiles = { viewModel.navigate(Route.Profiles) },
                            onCopy = { text ->
                                copyCode(context, text, null)
                                viewModel.showMessage("コピーしました")
                            },
                            updateState = updateState,
                            onCheckUpdate = { viewModel.updateController.checkNow() },
                            onDownloadUpdate = { viewModel.updateController.downloadNow() },
                            onInstallUpdate = { installUpdate() },
                            onCancelUpdate = { viewModel.updateController.cancelDownload() },
                        )

                        Route.Trash -> TrashScreen(
                            state = state,
                            onBack = { viewModel.navigate(Route.Accounts) },
                            onRestore = viewModel::restore,
                            onPurge = viewModel::purge,
                            onEmpty = viewModel::emptyTrash,
                        )

                        Route.Devices -> DevicesScreen(
                            state = state,
                            onBack = { viewModel.navigate(Route.Settings) },
                            onRename = viewModel::renameDevice,
                            onForget = viewModel::forgetDevice,
                        )

                        Route.Sync -> SyncScreen(
                            state = state,
                            initialCode = syncPrefill,
                            onBack = { viewModel.navigate(Route.Accounts) },
                            onAttach = viewModel::attachSync,
                            onEnableSync = { scope.launch { viewModel.repository.enableSync() } },
                            onCopy = { text ->
                                copyCode(context, text, null)
                                viewModel.showMessage("コピーしました")
                            },
                        )

                        Route.Profiles -> ProfilesScreen(
                            state = state,
                            onBack = { viewModel.navigate(Route.Settings) },
                            onSwitch = viewModel::switchProfile,
                            onCreate = viewModel::createProfile,
                            onRename = viewModel::renameProfile,
                            onDelete = viewModel::deleteProfile,
                        )
                    }
                }
            }
        }
    }

    if (installPermission) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { installPermission = false },
            title = { Text("インストールの許可が必要です") },
            text = {
                Text(
                    "Android の設定で、このアプリに「提供元不明のアプリ」のインストールを許可してください。" +
                        "許可すると、ダウンロード済みの APK をインストールできます。",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    installPermission = false
                    runCatching { context.startActivity(viewModel.updateController.unknownSourcesSettingsIntent()) }
                        .onFailure { viewModel.showMessage("設定を開けませんでした") }
                }) { Text("設定を開く") }
            },
            dismissButton = { TextButton(onClick = { installPermission = false }) { Text("あとで") } },
        )
    }
}

@Composable
private fun LoadingPane() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("読み込み中…", style = MaterialTheme.typography.bodyMedium)
    }
}
