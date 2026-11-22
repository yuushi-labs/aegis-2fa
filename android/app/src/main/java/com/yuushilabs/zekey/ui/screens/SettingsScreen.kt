package com.yuushilabs.zekey.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.yuushilabs.zekey.BuildConfig
import com.yuushilabs.zekey.core.Crypto
import com.yuushilabs.zekey.core.SyncCode
import com.yuushilabs.zekey.core.Trash
import com.yuushilabs.zekey.data.RepoState
import com.yuushilabs.zekey.data.ServerConfig
import com.yuushilabs.zekey.data.SyncState
import com.yuushilabs.zekey.ui.QrImage
import com.yuushilabs.zekey.ui.QrImagePickButton
import com.yuushilabs.zekey.ui.QrScannerPane
import com.yuushilabs.zekey.ui.components.ZekeyCard
import com.yuushilabs.zekey.ui.components.ConfirmDialog
import com.yuushilabs.zekey.ui.components.MutedText
import com.yuushilabs.zekey.ui.components.SectionTitle
import com.yuushilabs.zekey.ui.components.ThinDivider
import com.yuushilabs.zekey.ui.update.UpdateSection
import com.yuushilabs.zekey.ui.update.UpdateUiState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    state: RepoState,
    onBack: () -> Unit,
    onSettings: ((com.yuushilabs.zekey.data.ZekeySettings) -> com.yuushilabs.zekey.data.ZekeySettings) -> Unit,
    onChangePassword: (String, String, String) -> Unit,
    onEnableBiometric: () -> Unit,
    onDisableBiometric: () -> Unit,
    onSyncNow: () -> Unit,
    onDisableSync: () -> Unit,
    onEnableSync: () -> Unit,
    onOpenDevices: () -> Unit,
    onOpenProfiles: () -> Unit,
    onCopy: (String) -> Unit,
    updateState: UpdateUiState,
    onCheckUpdate: () -> Unit,
    onDownloadUpdate: () -> Unit,
    onInstallUpdate: () -> Unit,
    onCancelUpdate: () -> Unit,
) {
    var showPasswordDialog by remember { mutableStateOf(false) }
    var showSyncCode by remember { mutableStateOf(false) }
    var showSyncDetail by remember { mutableStateOf(false) }
    var autoLockMenu by remember { mutableStateOf(false) }
    var skewMenu by remember { mutableStateOf(false) }
    var confirmDisableSync by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                title = { Text("設定") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = "戻る")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            ZekeyCard {
                SectionTitle("セキュリティ")
                SettingRow(
                    title = "自動ロック",
                    description = "無操作のあいだ、この時間でロックします。",
                ) {
                    OutlinedButton(onClick = { autoLockMenu = true }) {
                        Text(autoLockLabel(state.settings.autoLockMinutes))
                    }
                    DropdownMenu(expanded = autoLockMenu, onDismissRequest = { autoLockMenu = false }) {
                        listOf(0, 1, 5, 15, 30).forEach { minutes ->
                            DropdownMenuItem(
                                text = { Text(autoLockLabel(minutes)) },
                                onClick = {
                                    autoLockMenu = false
                                    onSettings { it.copy(autoLockMinutes = minutes) }
                                },
                            )
                        }
                    }
                }
                ThinDivider()
                SettingSwitch(
                    title = "アプリを離れたら即ロック",
                    description = "自動ロックが「なし」のときは効きません。",
                    checked = state.settings.lockOnHide,
                    onChange = { value -> onSettings { it.copy(lockOnHide = value) } },
                )
                ThinDivider()
                SettingSwitch(
                    title = "指紋 / 顔で解錠",
                    description = "端末の生体認証でアンロックします（DEK を Keystore で保護）。",
                    checked = state.settings.biometricEnabled,
                    onChange = { value -> if (value) onEnableBiometric() else onDisableBiometric() },
                )
                ThinDivider()
                SettingRow(
                    title = "時計のずれ補正",
                    description = "認証コードが合わないときに ±2 ステップまで調整します。",
                ) {
                    OutlinedButton(onClick = { skewMenu = true }) { Text("${state.settings.clockSkew}") }
                    DropdownMenu(expanded = skewMenu, onDismissRequest = { skewMenu = false }) {
                        (-2..2).forEach { skew ->
                            DropdownMenuItem(
                                text = { Text(if (skew > 0) "+$skew" else "$skew") },
                                onClick = {
                                    skewMenu = false
                                    onSettings { it.copy(clockSkew = skew) }
                                },
                            )
                        }
                    }
                }
                ThinDivider()
                SettingSwitch(
                    title = "コピーしたコードを 30 秒で消す",
                    description = "クリップボードに残り続けないようにします。",
                    checked = state.settings.clearClipboard,
                    onChange = { value -> onSettings { it.copy(clearClipboard = value) } },
                )
                ThinDivider()
                OutlinedButton(onClick = { showPasswordDialog = true }, modifier = Modifier.fillMaxWidth()) {
                    Text("マスターパスワードを変更")
                }
            }

            ZekeyCard {
                SectionTitle("同期（ゼロ知識）")
                MutedText("接続先: ${ServerConfig.BASE_URL}")
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    MutedText(
                        when (state.syncState) {
                            SyncState.LOCAL_ONLY -> "この端末だけで使っています（送信していません）。"
                            SyncState.SYNCED -> "同期済み。最終同期: ${state.lastSyncedAt ?: "—"}"
                            SyncState.PENDING -> "同期待ち（変更は 2 秒後にまとめて送ります）。"
                            SyncState.ERROR -> state.syncError ?: "通信状態を確認して、もう一度お試しください。"
                            SyncState.CONFLICT -> "他の端末と競合しています。一覧画面で解決してください。"
                        },
                    )
                }
                if (state.syncState == SyncState.ERROR) {
                    TextButton(onClick = { showSyncDetail = !showSyncDetail }) {
                        Text(if (showSyncDetail) "詳細を閉じる" else "詳細を見る")
                    }
                    AnimatedVisibility(visible = showSyncDetail) {
                        Column {
                            MutedText("理由: ${state.syncErrorCode ?: "不明"}")
                            MutedText("最終同期: ${state.lastSyncedAt ?: "まだ"}")
                        }
                    }
                }
                if (!state.syncEnabled) {
                    Button(onClick = onEnableSync, modifier = Modifier.fillMaxWidth()) {
                        Text("このボルトで同期を始める")
                    }
                } else {
                    Button(onClick = onSyncNow, modifier = Modifier.fillMaxWidth()) { Text("今すぐ同期") }
                    OutlinedButton(
                        onClick = { showSyncCode = !showSyncCode },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(if (showSyncCode) "同期コードを隠す" else "同期コードを表示")
                    }
                    if (showSyncCode) {
                        val token = state.syncCode
                        if (token != null) {
                            Text(SyncCode.format(token), style = MaterialTheme.typography.bodyMedium)
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                                QrImage(token, size = 180)
                            }
                            TextButton(onClick = { onCopy(SyncCode.format(token)) }, modifier = Modifier.fillMaxWidth()) {
                                Text("同期コードをコピー")
                            }
                            MutedText("このコードとマスターパスワードがあれば、別の端末で同じボルトを開けます。")
                        }
                    }
                    OutlinedButton(onClick = onOpenDevices, modifier = Modifier.fillMaxWidth()) {
                        Text("同期している端末（${state.devices.size}）")
                    }
                    OutlinedButton(onClick = { confirmDisableSync = true }, modifier = Modifier.fillMaxWidth()) {
                        Text("同期を解除", color = MaterialTheme.colorScheme.error)
                    }
                }
                MutedText("サイト版の「📱 アプリでログイン」を押すと、このアプリが開いて自動でログインします。")
            }

            ZekeyCard {
                SectionTitle("ボルト")
                state.profiles.forEach { profile ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            profile.name + if (profile.id == state.activeProfileId) "（使用中）" else "",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
                OutlinedButton(onClick = onOpenProfiles, modifier = Modifier.fillMaxWidth()) {
                    Text("ボルトの管理")
                }
            }

            UpdateSection(
                state = updateState,
                versionName = BuildConfig.VERSION_NAME,
                onCheck = onCheckUpdate,
                onDownload = onDownloadUpdate,
                onInstall = onInstallUpdate,
                onCancel = onCancelUpdate,
            )

            ZekeyCard {
                SectionTitle("もしものとき")
                MutedText("パスワードを忘れた場合、この端末では復旧できません。同期を使っていれば、別端末のパスワードで開けます。")
                MutedText("アカウントの秘密鍵は、詳細画面の QR / otpauth:// から控えられます。")
            }
        }
    }

    if (showPasswordDialog) {
        ChangePasswordDialog(
            onDismiss = { showPasswordDialog = false },
            onSubmit = { current, next, confirm ->
                onChangePassword(current, next, confirm)
                showPasswordDialog = false
            },
        )
    }
    if (confirmDisableSync) {
        ConfirmDialog(
            title = "同期を解除しますか？",
            text = "サーバー上の暗号文を削除し、この端末だけのボルトに戻します。アカウントは消えません。",
            confirmLabel = "解除する",
            danger = true,
            onConfirm = {
                confirmDisableSync = false
                onDisableSync()
            },
            onDismiss = { confirmDisableSync = false },
        )
    }
}

/** 左に見出し・説明、右に操作を置く行。 */
@Composable
private fun SettingRow(
    title: String,
    description: String,
    content: @Composable () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            MutedText(description)
        }
        content()
    }
}

@Composable
private fun SettingSwitch(
    title: String,
    description: String,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            MutedText(description)
        }
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            modifier = Modifier.semantics { contentDescription = title },
        )
    }
}

private fun autoLockLabel(minutes: Int): String = if (minutes == 0) "なし" else "${minutes}分"

@Composable
private fun ChangePasswordDialog(
    onDismiss: () -> Unit,
    onSubmit: (String, String, String) -> Unit,
) {
    var current by rememberSaveable { mutableStateOf("") }
    var next by rememberSaveable { mutableStateOf("") }
    var confirm by rememberSaveable { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("パスワードを変更") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    current,
                    { current = it },
                    label = { Text("現在のパスワード") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    next,
                    { next = it },
                    label = { Text("新しいパスワード（${Crypto.MIN_PASSWORD_LENGTH}文字以上）") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    confirm,
                    { confirm = it },
                    label = { Text("新しいパスワード（確認）") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = { TextButton(onClick = { onSubmit(current, next, confirm) }) { Text("変更する") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("やめる") } },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrashScreen(
    state: RepoState,
    onBack: () -> Unit,
    onRestore: (String) -> Unit,
    onPurge: (String) -> Unit,
    onEmpty: () -> Unit,
) {
    var confirmPurge by remember { mutableStateOf<String?>(null) }
    var confirmEmpty by remember { mutableStateOf(false) }
    val trashed = state.trashedAccounts

    Scaffold(
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                title = { Text("ゴミ箱") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = "戻る")
                    }
                },
                actions = {
                    if (trashed.isNotEmpty()) {
                        TextButton(onClick = { confirmEmpty = true }) { Text("空にする") }
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (trashed.isEmpty()) {
                ZekeyCard { Text("ゴミ箱は空です") }
            }
            trashed.forEach { account ->
                ZekeyCard {
                    Text(account.displayName, style = MaterialTheme.typography.titleMedium)
                    MutedText("あと ${Trash.remainingDays(account)} 日で完全に削除されます")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { onRestore(account.id) }) { Text("復元") }
                        OutlinedButton(onClick = { confirmPurge = account.id }) { Text("完全に削除") }
                    }
                }
            }
        }
    }

    confirmPurge?.let { id ->
        ConfirmDialog(
            title = "完全に削除しますか？",
            text = "このアカウントは復元できません。同期中の他の端末からも消えます。",
            confirmLabel = "完全に削除",
            danger = true,
            onConfirm = {
                confirmPurge = null
                onPurge(id)
            },
            onDismiss = { confirmPurge = null },
        )
    }
    if (confirmEmpty) {
        ConfirmDialog(
            title = "ゴミ箱を空にしますか？",
            text = "ゴミ箱にあるアカウントをすべて完全に削除します。復元できません。",
            confirmLabel = "空にする",
            danger = true,
            onConfirm = {
                confirmEmpty = false
                onEmpty()
            },
            onDismiss = { confirmEmpty = false },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DevicesScreen(
    state: RepoState,
    onBack: () -> Unit,
    onRename: (String) -> Unit,
    onForget: (String) -> Unit,
) {
    var name by rememberSaveable(state.settings.deviceName) { mutableStateOf(state.settings.deviceName) }
    Scaffold(
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                title = { Text("同期している端末") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = "戻る")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            ZekeyCard {
                SectionTitle("この端末の名前")
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("名前") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(onClick = { onRename(name) }, modifier = Modifier.fillMaxWidth()) { Text("保存") }
            }
            ZekeyCard {
                SectionTitle("同期されたデバイス")
                if (state.devices.isEmpty()) MutedText("まだ記録がありません（次回の同期で記録されます）。")
                state.devices.forEach { device ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                device.name + if (device.id == state.settings.deviceId) "（この端末）" else "",
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            MutedText("${device.platform} / ${device.lastSyncedAt}")
                        }
                        if (device.id != state.settings.deviceId) {
                            TextButton(onClick = { onForget(device.id) }) { Text("一覧から消す") }
                        }
                    }
                }
                MutedText("一覧から消しても、その端末のボルトは消えません。")
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SyncScreen(
    state: RepoState,
    initialCode: String,
    onBack: () -> Unit,
    onAttach: (String) -> Unit,
    onEnableSync: () -> Unit,
    onCopy: (String) -> Unit,
) {
    var input by rememberSaveable(initialCode) { mutableStateOf(initialCode) }
    var scanning by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val context = LocalContext.current

    Scaffold(
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                title = { Text("同期") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = "戻る")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (state.syncEnabled) {
                ZekeyCard {
                    SectionTitle("この端末の同期コード")
                    val token = state.syncCode
                    if (token != null) {
                        Text(SyncCode.format(token), style = MaterialTheme.typography.bodyMedium)
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                            QrImage(token, size = 200)
                        }
                        Button(onClick = { onCopy(SyncCode.format(token)) }, modifier = Modifier.fillMaxWidth()) {
                            Text("コピー")
                        }
                    }
                    MutedText("別の端末の「同期コードを入力」でこのコードを使うと、同じボルトを開けます（マスターパスワードも必要）。")
                }
            } else {
                ZekeyCard {
                    SectionTitle("このボルトはローカル完結です")
                    MutedText("同期を使うと、別の端末やサイト版と同じボルトを開けます。")
                    Button(onClick = onEnableSync, modifier = Modifier.fillMaxWidth()) { Text("同期を始める") }
                }
            }

            ZekeyCard {
                SectionTitle("別の端末のコードを受け取る")
                MutedText("入力すると、この端末のボルトはサーバーの内容に置き換わります（この端末のアカウントは消えます）。")
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    label = { Text("同期コード（4文字区切りで可）") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { onAttach(input) }) { Text("接続する") }
                    TextButton(onClick = { scanning = !scanning }) { Text(if (scanning) "スキャンを閉じる" else "QR を読み取る") }
                }
                if (scanning) {
                    QrScannerPane(
                        onResult = { text ->
                            val token = SyncCode.extract(text)
                            if (token == null) error = "同期コードを読み取れませんでした" else {
                                input = token
                                error = null
                                scanning = false
                            }
                        },
                    )
                    QrImagePickButton(
                        label = "画像から読み取る",
                        onText = { text ->
                            val token = SyncCode.extract(text)
                            if (token == null) error = "同期コードを読み取れませんでした" else {
                                input = token
                                error = null
                            }
                        },
                        onError = { error = it },
                    )
                }
                error?.let { MutedText(it) }
            }

            ZekeyCard {
                SectionTitle("接続先")
                MutedText(ServerConfig.BASE_URL)
                MutedText("接続先はハードコードされています（変更できません）。")
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfilesScreen(
    state: RepoState,
    onBack: () -> Unit,
    onSwitch: (String) -> Unit,
    onCreate: (String, String) -> Unit,
    onRename: (String, String) -> Unit,
    onDelete: (String) -> Unit,
) {
    var showCreate by remember { mutableStateOf(false) }
    var renameTarget by remember { mutableStateOf<String?>(null) }
    var deleteTarget by remember { mutableStateOf<String?>(null) }
    var newName by rememberSaveable { mutableStateOf("") }
    var newPassword by rememberSaveable { mutableStateOf("") }

    Scaffold(
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                title = { Text("ボルト") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = "戻る")
                    }
                },
                actions = { TextButton(onClick = { showCreate = true }) { Text("追加") } },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            MutedText("ボルトごとにマスターパスワード・同期コード・ロック状態が独立しています。")
            state.profiles.forEach { profile ->
                ZekeyCard {
                    Text(
                        profile.name + if (profile.id == state.activeProfileId) "（使用中）" else "",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (profile.id != state.activeProfileId) {
                            TextButton(onClick = { onSwitch(profile.id) }) { Text("切替") }
                        }
                        TextButton(onClick = { renameTarget = profile.id }) { Text("名前") }
                        if (state.profiles.size > 1) {
                            TextButton(onClick = { deleteTarget = profile.id }) { Text("削除") }
                        }
                    }
                }
            }
        }
    }

    if (showCreate) {
        AlertDialog(
            onDismissRequest = { showCreate = false },
            title = { Text("ボルトを追加") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        newName,
                        { newName = it },
                        label = { Text("表示名") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        newPassword,
                        { newPassword = it },
                        label = { Text("マスターパスワード（${Crypto.MIN_PASSWORD_LENGTH}文字以上）") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    onCreate(newName, newPassword)
                    showCreate = false
                    newName = ""
                    newPassword = ""
                }) { Text("作成") }
            },
            dismissButton = { TextButton(onClick = { showCreate = false }) { Text("やめる") } },
        )
    }

    renameTarget?.let { id ->
        var name by rememberSaveable(id) { mutableStateOf(state.profiles.firstOrNull { it.id == id }?.name.orEmpty()) }
        AlertDialog(
            onDismissRequest = { renameTarget = null },
            title = { Text("名前を変更") },
            text = {
                OutlinedTextField(name, { name = it }, label = { Text("表示名") }, singleLine = true)
            },
            confirmButton = {
                TextButton(onClick = {
                    onRename(id, name)
                    renameTarget = null
                }) { Text("保存") }
            },
            dismissButton = { TextButton(onClick = { renameTarget = null }) { Text("やめる") } },
        )
    }

    deleteTarget?.let { id ->
        ConfirmDialog(
            title = "ボルトを削除しますか？",
            text = "このボルトの記録を端末から消します。復元できません（同期中なら、他の端末の記録は残ります）。",
            confirmLabel = "削除",
            danger = true,
            onConfirm = {
                onDelete(id)
                deleteTarget = null
            },
            onDismiss = { deleteTarget = null },
        )
    }
}
