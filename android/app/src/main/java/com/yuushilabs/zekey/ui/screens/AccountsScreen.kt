package com.yuushilabs.zekey.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AssistChip
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yuushilabs.zekey.core.Account
import com.yuushilabs.zekey.core.Hotp
import com.yuushilabs.zekey.core.Totp
import com.yuushilabs.zekey.core.VaultJson
import com.yuushilabs.zekey.data.RepoState
import com.yuushilabs.zekey.data.SyncState
import com.yuushilabs.zekey.ui.Route
import com.yuushilabs.zekey.ui.components.ZekeyCard
import com.yuushilabs.zekey.ui.components.CodeText
import com.yuushilabs.zekey.ui.components.ConfirmDialog
import com.yuushilabs.zekey.ui.components.IssuerAvatar
import com.yuushilabs.zekey.ui.components.MiniBadge
import com.yuushilabs.zekey.ui.components.MutedText
import com.yuushilabs.zekey.ui.components.RemainingRing
import com.yuushilabs.zekey.ui.components.StatusPill
import com.yuushilabs.zekey.ui.update.UpdateBanner
import com.yuushilabs.zekey.ui.update.UpdateUiState
import kotlinx.coroutines.delay

/** 秒単位だけを使う画面（詳細）向け。 */
@Composable
fun rememberNowSeconds(): Long = rememberNowMillis() / 1000

/** コードは 1 秒単位、リングは 100ms 単位で動かす。 */
@Composable
fun rememberNowMillis(): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            now = System.currentTimeMillis()
            delay(100)
        }
    }
    return now
}

fun copyCode(context: Context, code: String, clearAfterSeconds: Int?) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("Zekey 2FA", code))
    if (clearAfterSeconds != null && clearAfterSeconds > 0) {
        val label = "Zekey 2FA"
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            val current = clipboard.primaryClip?.getItemAt(0)?.text?.toString()
            if (current == code) {
                clipboard.setPrimaryClip(ClipData.newPlainText(label, ""))
            }
        }, clearAfterSeconds * 1000L)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccountsScreen(
    state: RepoState,
    route: Route,
    onNavigate: (Route) -> Unit,
    onCopy: (Account) -> Unit,
    onTogglePin: (String) -> Unit,
    onDelete: (String) -> Unit,
    onLock: () -> Unit,
    onSyncNow: () -> Unit,
    onResolveConflict: (String) -> Unit,
    onSortMode: (String) -> Unit,
    onSwitchProfile: (String) -> Unit,
    updateState: UpdateUiState,
    onCheckUpdate: () -> Unit,
    onDownloadUpdate: () -> Unit,
    onInstallUpdate: () -> Unit,
    onSkipUpdate: () -> Unit,
    onCancelUpdate: () -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    var searchOpen by rememberSaveable { mutableStateOf(false) }
    var pendingDelete by remember { mutableStateOf<Account?>(null) }
    var copiedId by remember { mutableStateOf<String?>(null) }
    var vaultSheet by remember { mutableStateOf(false) }
    var syncDetail by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    val nowMillis = rememberNowMillis()
    val now = nowMillis / 1000
    val haptics = LocalHapticFeedback.current

    val accounts = remember(state.accounts, query, state.settings.sortMode) {
        val active = state.accounts.filterNot { it.isTrashed }
        val filtered = if (query.isBlank()) active else active.filter {
            it.issuer.contains(query, ignoreCase = true) ||
                it.label.contains(query, ignoreCase = true) ||
                it.notes.orEmpty().contains(query, ignoreCase = true)
        }
        sortAccounts(filtered, state.settings.sortMode)
    }

    // コピーの「済み」表示は 1.5 秒で元に戻す。
    LaunchedEffect(copiedId) {
        if (copiedId == null) return@LaunchedEffect
        delay(1_500)
        copiedId = null
    }
    // 手動更新のスピナーは、同期が終わったら止める。
    LaunchedEffect(state.syncState) {
        if (refreshing && state.syncState != SyncState.PENDING) {
            delay(250)
            refreshing = false
        }
    }

    fun copyWithFeedback(account: Account) {
        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        onCopy(account)
        copiedId = account.id
    }

    Scaffold(
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                ),
                title = {
                    Column {
                        Text("Zekey 2FA", style = MaterialTheme.typography.headlineSmall)
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            AssistChip(
                                onClick = { vaultSheet = true },
                                label = {
                                    Text(
                                        state.vaultName,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                },
                            )
                            SyncStatusPill(state, onSyncNow, onOpenDetail = { syncDetail = true })
                        }
                    }
                },
                actions = {
                    IconButton(onClick = { searchOpen = !searchOpen }) {
                        Icon(Icons.Filled.Search, contentDescription = "検索")
                    }
                    IconButton(onClick = { onNavigate(Route.Settings) }) {
                        Icon(Icons.Filled.Settings, contentDescription = "設定")
                    }
                    IconButton(onClick = onLock) {
                        Icon(Icons.Filled.Lock, contentDescription = "ロック")
                    }
                },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { onNavigate(Route.Add) }) {
                Icon(Icons.Filled.Add, contentDescription = "アカウントを追加")
            }
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                if (state.syncEnabled) {
                    refreshing = true
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    onSyncNow()
                }
            },
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 96.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item(key = "update") {
                    UpdateBanner(
                        state = updateState,
                        onDownload = onDownloadUpdate,
                        onInstall = onInstallUpdate,
                        onSkip = onSkipUpdate,
                        onCancel = onCancelUpdate,
                        onRetry = onCheckUpdate,
                    )
                }

                item(key = "search") {
                    AnimatedVisibility(
                        visible = searchOpen,
                        enter = fadeIn(tween(150)) + expandVertically(tween(180)),
                        exit = fadeOut(tween(120)) + shrinkVertically(tween(150)),
                    ) {
                        OutlinedTextField(
                            value = query,
                            onValueChange = { query = it },
                            label = { Text("検索（サービス名・アカウント名・メモ）") },
                            singleLine = true,
                            trailingIcon = {
                                if (query.isNotEmpty()) {
                                    IconButton(onClick = { query = "" }) {
                                        Icon(Icons.Filled.Clear, contentDescription = "入力を消す")
                                    }
                                }
                            },
                            supportingText = {
                                val text = when {
                                    query.isBlank() -> "全 ${state.activeAccounts.size} 件"
                                    accounts.isEmpty() -> "一致するアカウントはありません"
                                    else -> "${accounts.size} 件が一致"
                                }
                                Text(text)
                            },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }

                item(key = "sort") {
                    Row(
                        modifier = Modifier.horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        SortChip("手動順", "manual", state.settings.sortMode, onSortMode)
                        SortChip("よく使う順", "usage", state.settings.sortMode, onSortMode)
                        SortChip("名前順", "name", state.settings.sortMode, onSortMode)
                    }
                }

                if (state.conflict != null || state.syncState == SyncState.ERROR) {
                    item(key = "sync-banner") {
                        SyncBanner(state, onSyncNow, onResolveConflict, onOpenDetail = { syncDetail = true })
                    }
                }

                if (accounts.isEmpty()) {
                    item(key = "empty") {
                        ZekeyCard {
                            Text(
                                if (state.activeAccounts.isEmpty()) "アカウントがありません" else "見つかりませんでした",
                                style = MaterialTheme.typography.titleMedium,
                            )
                            MutedText(
                                if (state.activeAccounts.isEmpty()) {
                                    "右下の + から追加できます。QR 読み取り・手入力・Google Authenticator からの移行に対応しています。"
                                } else {
                                    "検索語を短くするか、別の名前で試してください。"
                                },
                            )
                        }
                    }
                }

                items(accounts, key = { it.id }) { account ->
                    AccountRow(
                        account = account,
                        nowMillis = nowMillis,
                        now = now,
                        skew = state.settings.clockSkew,
                        copied = copiedId == account.id,
                        onCopy = { copyWithFeedback(account) },
                        onOpen = { onNavigate(Route.Detail(account.id)) },
                        onTogglePin = { onTogglePin(account.id) },
                        onDelete = { pendingDelete = account },
                    )
                }

                item(key = "trash") {
                    TextButton(onClick = { onNavigate(Route.Trash) }, modifier = Modifier.fillMaxWidth()) {
                        Text("ゴミ箱（${state.trashedAccounts.size}）")
                    }
                }
            }
        }
    }

    if (vaultSheet) {
        val sheetState = rememberModalBottomSheetState()
        ModalBottomSheet(onDismissRequest = { vaultSheet = false }, sheetState = sheetState) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 20.dp, end = 20.dp, bottom = 28.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text("ボルトを切り替える", style = MaterialTheme.typography.titleLarge)
                MutedText("ボルトごとにマスターパスワードと同期コードが独立しています。")
                state.profiles.forEach { profile ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            profile.name + if (profile.id == state.activeProfileId) "（使用中）" else "",
                            style = MaterialTheme.typography.bodyLarge,
                        )
                        if (profile.id != state.activeProfileId) {
                            TextButton(onClick = {
                                vaultSheet = false
                                onSwitchProfile(profile.id)
                            }) { Text("切り替え") }
                        }
                    }
                }
                ThinDividerOnBackground()
                TextButton(
                    onClick = {
                        vaultSheet = false
                        onNavigate(Route.Profiles)
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("ボルトの管理") }
            }
        }
    }

    if (syncDetail) {
        SyncDetailDialog(state = state, onDismiss = { syncDetail = false }, onRetry = onSyncNow)
    }

    pendingDelete?.let { account ->
        ConfirmDialog(
            title = "ゴミ箱に移しますか？",
            text = "「${account.displayName}」をゴミ箱に移します。30日間は復元できます。同期中は他の端末からも消えます。",
            confirmLabel = "ゴミ箱に移す",
            danger = true,
            onConfirm = {
                onDelete(account.id)
                pendingDelete = null
            },
            onDismiss = { pendingDelete = null },
        )
    }
}

@Composable
private fun ThinDividerOnBackground() {
    androidx.compose.material3.HorizontalDivider(
        modifier = Modifier.padding(vertical = 6.dp),
        color = MaterialTheme.colorScheme.outline.copy(alpha = 0.3f),
    )
}

/** 同期の状態を 1 語で示すピル。タップで再試行（エラー時は詳細）。 */
@Composable
private fun SyncStatusPill(state: RepoState, onSyncNow: () -> Unit, onOpenDetail: () -> Unit) {
    val (label, color) = when {
        !state.syncEnabled -> "ローカルのみ" to MaterialTheme.colorScheme.onSurfaceVariant
        state.syncState == SyncState.SYNCED -> "同期済み" to MaterialTheme.colorScheme.primary
        state.syncState == SyncState.PENDING -> "同期待ち" to MaterialTheme.colorScheme.secondary
        state.syncState == SyncState.CONFLICT -> "要確認" to MaterialTheme.colorScheme.error
        state.syncState == SyncState.ERROR -> "エラー" to MaterialTheme.colorScheme.error
        else -> "同期" to MaterialTheme.colorScheme.onSurfaceVariant
    }
    StatusPill(
        text = label,
        color = color,
        onClick = when {
            !state.syncEnabled -> null
            state.syncState == SyncState.ERROR || state.syncState == SyncState.CONFLICT -> onOpenDetail
            else -> onSyncNow
        },
    )
}

@Composable
private fun SortChip(label: String, value: String, selected: String, onSelect: (String) -> Unit) {
    FilterChip(
        selected = selected == value,
        onClick = { onSelect(value) },
        label = { Text(label) },
    )
}

@Composable
private fun SyncBanner(
    state: RepoState,
    onSyncNow: () -> Unit,
    onResolveConflict: (String) -> Unit,
    onOpenDetail: () -> Unit,
) {
    when {
        state.conflict != null -> {
            ZekeyCard {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Icons.Filled.Warning, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text("他の端末と競合しました", style = MaterialTheme.typography.titleMedium)
                }
                MutedText("どちらを残すか選んでください。マージすると両方の変更を残せます。")
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = { onResolveConflict("merge") }) { Text("マージ") }
                    TextButton(onClick = { onResolveConflict("overwrite") }) { Text("この端末を残す") }
                    TextButton(onClick = { onResolveConflict("discard") }) { Text("サーバーを残す") }
                }
            }
        }

        state.syncState == SyncState.ERROR -> {
            ZekeyCard {
                Text("同期できませんでした", style = MaterialTheme.typography.titleMedium)
                MutedText(state.syncError ?: "通信状態を確認して、もう一度お試しください。")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = onSyncNow) { Text("もう一度同期") }
                    TextButton(onClick = onOpenDetail) { Text("詳細") }
                }
            }
        }

        else -> Unit
    }
}

/** 同期エラーの詳細（日本語のメッセージと、デバッグ用のコード）。 */
@Composable
private fun SyncDetailDialog(state: RepoState, onDismiss: () -> Unit, onRetry: () -> Unit) {
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("同期の状態") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(state.syncError ?: "問題はありません。", style = MaterialTheme.typography.bodyMedium)
                val detail = state.syncErrorCode
                if (!detail.isNullOrBlank()) {
                    MutedText("詳細: $detail")
                }
                MutedText("最終同期: ${state.lastSyncedAt ?: "まだ"}")
                MutedText("同期コードを使うと、別の端末と同じボルトを開けます。")
            }
        },
        confirmButton = {
            TextButton(onClick = {
                onDismiss()
                onRetry()
            }) { Text("もう一度同期") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AccountRow(
    account: Account,
    nowMillis: Long,
    now: Long,
    skew: Int,
    copied: Boolean,
    onCopy: () -> Unit,
    onOpen: () -> Unit,
    onTogglePin: () -> Unit,
    onDelete: () -> Unit,
) {
    val code = remember(account.secret, account.counter, account.algorithm, account.digits, account.period, now, skew) {
        codeFor(account, now, skew)
    }
    // period は 1〜300 に正規化されているが、0 が来ても割り算で落ちないようにする。
    val periodMillis = (account.period.coerceAtLeast(1)) * 1_000L
    val remainingMillis = remember(nowMillis, periodMillis) {
        val offset = (nowMillis % periodMillis)
        if (offset == 0L) periodMillis else periodMillis - offset
    }
    val warning = account.isTotp && remainingMillis <= 5_000
    val codeColor by animateColorAsState(
        targetValue = if (warning) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
        animationSpec = tween(200),
        label = "code-color",
    )
    var menu by remember { mutableStateOf(false) }

    ZekeyCard(onClick = onCopy) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            IssuerAvatar(account.issuer.ifBlank { account.label })
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        account.issuer.ifBlank { account.label },
                        style = MaterialTheme.typography.bodyLarge,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    if (account.pinned) {
                        Icon(
                            Icons.Filled.Star,
                            contentDescription = "ピン留め",
                            modifier = Modifier.size(14.dp),
                            tint = MaterialTheme.colorScheme.secondary,
                        )
                    }
                    if (account.hasNotes) MiniBadge("メモ")
                    if (account.unusedRecoveryCodes > 0) MiniBadge("控え ${account.unusedRecoveryCodes}")
                }
                if (account.issuer.isNotBlank() && account.label.isNotBlank()) {
                    MutedText(account.label, modifier = Modifier.fillMaxWidth())
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (copied) {
                        Icon(
                            Icons.Filled.Check,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.primary,
                        )
                    }
                    CodeText(code, fontSize = 24, color = codeColor)
                    if (account.isTotp) {
                        RemainingRing(
                            remainingMillis = remainingMillis,
                            periodMillis = periodMillis,
                            modifier = Modifier.size(26.dp),
                        )
                        Text(
                            "${(remainingMillis + 999) / 1000}",
                            style = MaterialTheme.typography.bodySmall,
                            color = if (warning) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        MiniBadge("HOTP")
                    }
                }
                if (copied) {
                    Text("コピー済み", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                }
            }
            IconButton(onClick = { menu = true }) {
                Icon(Icons.Filled.MoreVert, contentDescription = "操作")
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(
                    text = { Text("詳細・編集") },
                    onClick = {
                        menu = false
                        onOpen()
                    },
                )
                DropdownMenuItem(
                    text = { Text(if (account.pinned) "ピン留めを解除" else "ピン留め") },
                    onClick = {
                        menu = false
                        onTogglePin()
                    },
                )
                DropdownMenuItem(
                    text = { Text("ゴミ箱に移す", color = MaterialTheme.colorScheme.error) },
                    onClick = {
                        menu = false
                        onDelete()
                    },
                )
            }
        }
    }
}

fun codeFor(account: Account, nowSeconds: Long, skew: Int): String = try {
    if (account.isTotp) {
        Totp.generate(
            secret = account.secret,
            unixSeconds = nowSeconds,
            algorithm = account.algorithm,
            digits = account.digits,
            period = account.period,
        ).let { code ->
            if (skew == 0) code else {
                Totp.generate(
                    secret = account.secret,
                    unixSeconds = nowSeconds + skew * account.period.toLong(),
                    algorithm = account.algorithm,
                    digits = account.digits,
                    period = account.period,
                )
            }
        }
    } else {
        Hotp.generate(account.secret, account.counter, account.algorithm, account.digits)
    }
} catch (_: Exception) {
    "------".take(account.digits)
}

fun sortAccounts(accounts: List<Account>, mode: String): List<Account> {
    val base = VaultJson.manualSort(accounts)
    return when (mode) {
        "usage" -> base.sortedWith(
            compareByDescending<Account> { it.useCount ?: 0 }
                .thenByDescending { it.lastUsedAt.orEmpty() },
        )
        "name" -> base.sortedWith(
            compareBy<Account> { if (it.pinned) 0 else 1 }
                .thenBy { (it.issuer.ifBlank { it.label }).lowercase() }
                .thenBy { it.label.lowercase() },
        )
        else -> base
    }
}
