package com.yuushilabs.aegis.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.yuushilabs.aegis.core.Account
import com.yuushilabs.aegis.core.Hotp
import com.yuushilabs.aegis.core.Totp
import com.yuushilabs.aegis.core.VaultJson
import com.yuushilabs.aegis.data.RepoState
import com.yuushilabs.aegis.data.SyncState
import com.yuushilabs.aegis.ui.Route
import com.yuushilabs.aegis.ui.components.AegisCard
import com.yuushilabs.aegis.ui.components.CodeText
import com.yuushilabs.aegis.ui.components.ConfirmDialog
import com.yuushilabs.aegis.ui.components.IssuerAvatar
import com.yuushilabs.aegis.ui.components.MutedText
import com.yuushilabs.aegis.ui.components.RemainingRing
import kotlinx.coroutines.delay

@Composable
fun rememberNowSeconds(): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis() / 1000) }
    LaunchedEffect(Unit) {
        while (true) {
            now = System.currentTimeMillis() / 1000
            delay(500)
        }
    }
    return now
}

fun copyCode(context: Context, code: String, clearAfterSeconds: Int?) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("Aegis 2FA", code))
    if (clearAfterSeconds != null && clearAfterSeconds > 0) {
        val label = "Aegis 2FA"
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
) {
    var query by rememberSaveable { mutableStateOf("") }
    var searchOpen by rememberSaveable { mutableStateOf(false) }
    var pendingDelete by remember { mutableStateOf<Account?>(null) }
    val now = rememberNowSeconds()

    val accounts = remember(state.accounts, query, state.settings.sortMode) {
        val active = state.accounts.filterNot { it.isTrashed }
        val filtered = if (query.isBlank()) active else active.filter {
            it.issuer.contains(query, ignoreCase = true) ||
                it.label.contains(query, ignoreCase = true)
        }
        sortAccounts(filtered, state.settings.sortMode)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Aegis 2FA", style = MaterialTheme.typography.headlineSmall)
                        MutedText(state.vaultName)
                    }
                },
                actions = {
                    IconButton(onClick = { searchOpen = !searchOpen }) {
                        Icon(Icons.Filled.Search, contentDescription = "検索")
                    }
                    IconButton(onClick = { onNavigate(Route.Settings) }) {
                        Icon(Icons.Filled.Settings, contentDescription = "設定")
                    }
                    TextButton(onClick = onLock) { Text("ロック") }
                },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { onNavigate(Route.Add) }) {
                Icon(Icons.Filled.Add, contentDescription = "アカウントを追加")
            }
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 96.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (searchOpen) {
                item {
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        label = { Text("検索（サービス名・アカウント名）") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SortChip("手動順", "manual", state.settings.sortMode, onSortMode)
                    SortChip("よく使う順", "usage", state.settings.sortMode, onSortMode)
                    SortChip("名前順", "name", state.settings.sortMode, onSortMode)
                }
            }
            item { SyncBanner(state, onSyncNow, onResolveConflict) }

            if (accounts.isEmpty()) {
                item {
                    AegisCard {
                        Text("アカウントがありません", style = MaterialTheme.typography.titleMedium)
                        MutedText("右下の + から追加できます。QR 読み取り・手入力・Google Authenticator からの移行に対応しています。")
                    }
                }
            }

            items(accounts, key = { it.id }) { account ->
                AccountRow(
                    account = account,
                    now = now,
                    skew = state.settings.clockSkew,
                    onClick = { onNavigate(Route.Detail(account.id)) },
                    onCopy = { onCopy(account) },
                    onTogglePin = { onTogglePin(account.id) },
                    onDelete = { pendingDelete = account },
                )
            }

            item {
                TextButton(onClick = { onNavigate(Route.Trash) }, modifier = Modifier.fillMaxWidth()) {
                    Text("ゴミ箱（${state.trashedAccounts.size}）")
                }
            }
        }
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
private fun SortChip(label: String, value: String, selected: String, onSelect: (String) -> Unit) {
    FilterChip(
        selected = selected == value,
        onClick = { onSelect(value) },
        label = { Text(label) },
    )
}

@Composable
private fun SyncBanner(state: RepoState, onSyncNow: () -> Unit, onResolveConflict: (String) -> Unit) {
    when {
        state.conflict != null -> {
            AegisCard {
                Text("他の端末と競合しました", style = MaterialTheme.typography.titleMedium)
                MutedText("どちらを残すか選んでください。マージすると両方の変更を残せます。")
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = { onResolveConflict("merge") }) { Text("マージ") }
                    TextButton(onClick = { onResolveConflict("overwrite") }) { Text("この端末を残す") }
                    TextButton(onClick = { onResolveConflict("discard") }) { Text("サーバーを残す") }
                }
            }
        }
        state.syncState == SyncState.ERROR -> {
            AegisCard {
                Text("同期できませんでした", style = MaterialTheme.typography.titleMedium)
                MutedText(state.syncError ?: "network")
                TextButton(onClick = onSyncNow) { Text("もう一度同期") }
            }
        }
        else -> Unit
    }
}

@Composable
private fun AccountRow(
    account: Account,
    now: Long,
    skew: Int,
    onClick: () -> Unit,
    onCopy: () -> Unit,
    onTogglePin: () -> Unit,
    onDelete: () -> Unit,
) {
    val code = remember(account.secret, account.counter, account.algorithm, account.digits, account.period, now, skew) {
        codeFor(account, now, skew)
    }
    val remaining = remember(account.period, now) { Totp.secondsRemaining(now, account.period) }
    AegisCard(modifier = Modifier.clickable(onClick = onClick)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            IssuerAvatar(account.issuer.ifBlank { account.label })
            Column(modifier = Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        account.issuer.ifBlank { account.label },
                        style = MaterialTheme.typography.bodyLarge,
                        maxLines = 1,
                    )
                    if (account.pinned) MutedText("ピン")
                    if (account.hasNotes) MutedText("メモ")
                    if (account.unusedRecoveryCodes > 0) MutedText("未使用 ${account.unusedRecoveryCodes}")
                }
                if (account.issuer.isNotBlank() && account.label.isNotBlank()) {
                    MutedText(account.label, modifier = Modifier.fillMaxWidth())
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    CodeText(code, fontSize = 24)
                    if (account.isTotp) {
                        RemainingRing(remaining = remaining, period = account.period, modifier = Modifier.size(26.dp))
                        MutedText("${remaining}s")
                    } else {
                        MutedText("HOTP")
                    }
                }
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = onCopy) { Text("コピー") }
            TextButton(onClick = onTogglePin) { Text(if (account.pinned) "ピン解除" else "ピン") }
            TextButton(onClick = onDelete) { Text("削除") }
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
