package com.yuushilabs.zekey.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.yuushilabs.zekey.core.Account
import com.yuushilabs.zekey.core.Base32
import com.yuushilabs.zekey.core.Otpauth
import com.yuushilabs.zekey.core.RecoveryCode
import com.yuushilabs.zekey.core.Totp
import com.yuushilabs.zekey.core.Trash
import com.yuushilabs.zekey.ui.QrImage
import com.yuushilabs.zekey.ui.components.ZekeyCard
import com.yuushilabs.zekey.ui.components.CodeText
import com.yuushilabs.zekey.ui.components.ConfirmDialog
import com.yuushilabs.zekey.ui.components.DetailRow
import com.yuushilabs.zekey.ui.components.ErrorBanner
import com.yuushilabs.zekey.ui.components.IssuerAvatar
import com.yuushilabs.zekey.ui.components.MiniBadge
import com.yuushilabs.zekey.ui.components.MutedText
import com.yuushilabs.zekey.ui.components.VisibilityToggle
import com.yuushilabs.zekey.ui.components.RemainingRing
import com.yuushilabs.zekey.ui.components.SectionTitle
import com.yuushilabs.zekey.ui.components.ThinDivider
import kotlinx.coroutines.delay
import java.util.UUID

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccountDetailScreen(
    account: Account,
    skew: Int,
    onBack: () -> Unit,
    onSave: (Account) -> Unit,
    onCopy: (String) -> Unit,
    onAdvanceHotp: (String) -> Unit,
    onDelete: (String) -> Unit,
    onRestore: (String) -> Unit,
    onPurge: (String) -> Unit,
) {
    val nowMillis = rememberNowMillis()
    val now = nowMillis / 1000
    val haptics = LocalHapticFeedback.current
    var editing by rememberSaveable { mutableStateOf(false) }
    var issuer by rememberSaveable(account.id) { mutableStateOf(account.issuer) }
    var label by rememberSaveable(account.id) { mutableStateOf(account.label) }
    var secret by rememberSaveable(account.id) { mutableStateOf(account.secret) }
    var algorithm by rememberSaveable(account.id) { mutableStateOf(account.algorithm) }
    var digits by rememberSaveable(account.id) { mutableStateOf(account.digits) }
    var period by rememberSaveable(account.id) { mutableStateOf(account.period.toString()) }
    var counter by rememberSaveable(account.id) { mutableStateOf(account.counter.toString()) }
    var notes by rememberSaveable(account.id) { mutableStateOf(account.notes.orEmpty()) }
    var codesText by remember(account.recoveryCodes) {
        mutableStateOf(account.recoveryCodes.orEmpty().joinToString("\n") { it.code })
    }
    var revealSecret by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var copied by remember { mutableStateOf(false) }

    // 編集を始めるときは、その時点の最新の値（同期で変わっている可能性がある）から入力を初期化する。
    LaunchedEffect(editing, account.id, account.updatedAt) {
        if (!editing) return@LaunchedEffect
        issuer = account.issuer
        label = account.label
        secret = account.secret
        algorithm = account.algorithm
        digits = account.digits
        period = account.period.toString()
        counter = account.counter.toString()
        notes = account.notes.orEmpty()
    }
    LaunchedEffect(copied) {
        if (!copied) return@LaunchedEffect
        delay(1_500)
        copied = false
    }
    var confirmDelete by remember { mutableStateOf(false) }
    var confirmPurge by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }

    val code = remember(account, now, skew) { codeFor(account, now, skew) }
    val otpauth = remember(account) { Otpauth.build(account) }
    // period は 1〜300 に正規化されているが、0 が来ても割り算で落ちないようにする。
    val periodMillis = (account.period.coerceAtLeast(1)) * 1_000L
    val remainingMillis = remember(nowMillis, periodMillis) {
        val offset = nowMillis % periodMillis
        if (offset == 0L) periodMillis else periodMillis - offset
    }
    val warning = account.isTotp && remainingMillis <= 5_000
    val codeColor by animateColorAsState(
        targetValue = if (warning) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
        animationSpec = tween(200),
        label = "detail-code-color",
    )

    fun copy(value: String, feedback: Boolean = false) {
        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        onCopy(value)
        if (feedback) copied = true
    }

    Scaffold(
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                title = { Text(account.displayName, maxLines = 1) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = "戻る")
                    }
                },
                actions = {
                    if (!account.isTrashed) {
                        IconButton(onClick = { editing = !editing }) {
                            Icon(Icons.Filled.Edit, contentDescription = if (editing) "編集をやめる" else "編集")
                        }
                        IconButton(onClick = { menu = true }) {
                            Icon(Icons.Filled.MoreVert, contentDescription = "その他")
                        }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(
                                text = { Text("otpauth:// をコピー") },
                                onClick = {
                                    menu = false
                                    copy(otpauth)
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("ゴミ箱に移す", color = MaterialTheme.colorScheme.error) },
                                onClick = {
                                    menu = false
                                    confirmDelete = true
                                },
                            )
                        }
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
            if (account.isTrashed) {
                val days = Trash.remainingDays(account)
                ZekeyCard {
                    SectionTitle("ゴミ箱の中")
                    MutedText("あと ${days} 日で完全に削除されます。復元すると元の場所に戻ります。")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { onRestore(account.id) }) { Text("復元する") }
                        OutlinedButton(onClick = { confirmPurge = true }) { Text("完全に削除") }
                    }
                }
            } else {
                ZekeyCard {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        IssuerAvatar(account.issuer.ifBlank { account.label }, size = 44)
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                account.issuer.ifBlank { account.label },
                                style = MaterialTheme.typography.titleMedium,
                            )
                            if (account.label.isNotBlank()) MutedText(account.label)
                        }
                        if (account.pinned) MiniBadge("ピン留め")
                    }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        CodeText(code, fontSize = 34, color = codeColor)
                        if (account.isTotp) {
                            RemainingRing(remainingMillis, periodMillis, modifier = Modifier.size(30.dp))
                            Text(
                                "${(remainingMillis + 999) / 1000}s",
                                style = MaterialTheme.typography.bodySmall,
                                color = if (warning) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    Button(onClick = { copy(code, feedback = true) }, modifier = Modifier.fillMaxWidth()) {
                        if (copied) {
                            Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(18.dp))
                        }
                        Text(if (copied) "  コピーしました" else "コピー")
                    }
                    if (!account.isTotp) {
                        OutlinedButton(onClick = { onAdvanceHotp(account.id) }, modifier = Modifier.fillMaxWidth()) {
                            Text("次のコードへ（カウンタ +1）")
                        }
                    }
                    MutedText(
                        if (account.isTotp) "${account.algorithm} / ${account.digits}桁 / ${account.period}秒ごと"
                        else "HOTP / ${account.algorithm} / ${account.digits}桁 / カウンタ ${account.counter}",
                    )
                }

                ZekeyCard {
                    SectionTitle("別の端末で読み取る")
                    MutedText("この QR は otpauth:// 形式です。追加したい端末で読み取ってください。")
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                        QrImage(otpauth, size = 200)
                    }
                    OutlinedButton(onClick = { copy(otpauth) }, modifier = Modifier.fillMaxWidth()) {
                        Text("otpauth:// をコピー")
                    }
                }
            }

            ZekeyCard {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    SectionTitle(if (editing) "編集" else "詳細")
                    if (editing) {
                        TextButton(onClick = { editing = false }) { Text("やめる") }
                    }
                }
                if (editing) {
                    OutlinedTextField(
                        value = issuer,
                        onValueChange = { issuer = it },
                        label = { Text("サービス名") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = label,
                        onValueChange = { label = it },
                        label = { Text("アカウント名") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = secret,
                        onValueChange = { secret = it },
                        label = { Text("秘密鍵（Base32）") },
                        singleLine = true,
                        visualTransformation = if (revealSecret) VisualTransformation.None else PasswordVisualTransformation(),
                        trailingIcon = { VisibilityToggle(revealed = revealSecret) { revealSecret = !revealSecret } },
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(
                        modifier = Modifier.horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        listOf("SHA1", "SHA256", "SHA512").forEach { option ->
                            FilterChip(
                                selected = algorithm == option,
                                onClick = { algorithm = option },
                                label = { Text(option) },
                            )
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(6, 8).forEach { option ->
                            FilterChip(
                                selected = digits == option,
                                onClick = { digits = option },
                                label = { Text("$option 桁") },
                            )
                        }
                    }
                    if (account.isTotp) {
                        OutlinedTextField(
                            value = period,
                            onValueChange = { period = it.filter(Char::isDigit) },
                            label = { Text("周期（秒）") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    } else {
                        OutlinedTextField(
                            value = counter,
                            onValueChange = { counter = it.filter(Char::isDigit) },
                            label = { Text("カウンタ") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    OutlinedTextField(
                        value = notes,
                        onValueChange = { notes = it },
                        label = { Text("メモ") },
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        minLines = 2,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    error?.let { ErrorBanner(it) }
                    Button(
                        onClick = {
                            val normalized = runCatching { Base32.canonical(secret) }.getOrNull()
                            val periodValue = period.toIntOrNull()
                            val counterValue = counter.toLongOrNull()
                            error = when {
                                normalized == null || normalized.isEmpty() -> "秘密鍵が正しい Base32 ではありません"
                                account.isTotp && periodValue == null -> "周期は秒単位の整数で入力してください"
                                !account.isTotp && counterValue == null -> "カウンタは 0 以上の整数で入力してください"
                                account.isTotp && periodValue != null && periodValue !in Totp.MIN_PERIOD..Totp.MAX_PERIOD ->
                                    "周期は ${Totp.MIN_PERIOD}〜${Totp.MAX_PERIOD} 秒にしてください"
                                else -> {
                                    onSave(
                                        account.copy(
                                            issuer = issuer.trim(),
                                            label = label.trim(),
                                            secret = normalized,
                                            algorithm = algorithm,
                                            digits = digits,
                                            period = periodValue ?: account.period,
                                            counter = counterValue ?: account.counter,
                                            notes = notes.trim().ifEmpty { null },
                                        ),
                                    )
                                    editing = false
                                    null
                                }
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("保存する") }
                } else {
                    DetailRow("サービス名", account.issuer.ifBlank { "—" })
                    ThinDivider()
                    DetailRow("アカウント名", account.label.ifBlank { "—" })
                    ThinDivider()
                    DetailRow("種別", if (account.isTotp) "TOTP（時間ベース）" else "HOTP（カウンタ）")
                    ThinDivider()
                    DetailRow("アルゴリズム", account.algorithm)
                    ThinDivider()
                    DetailRow("桁数", "${account.digits} 桁")
                    ThinDivider()
                    if (account.isTotp) {
                        DetailRow("周期", "${account.period} 秒")
                    } else {
                        DetailRow("カウンタ", "${account.counter}")
                    }
                    ThinDivider()
                    DetailRow("ピン留め", if (account.pinned) "あり" else "なし")
                    if (account.hasNotes) {
                        ThinDivider()
                        DetailRow("メモ", account.notes.orEmpty())
                    }
                }
            }

            if (!account.isTrashed) {
                RecoveryCodesCard(
                    account = account,
                    codesText = codesText,
                    onCodesText = { codesText = it },
                    onSaveCodes = { list -> onSave(account.copy(recoveryCodes = list.ifEmpty { null })) },
                    onCopy = { copy(it) },
                )
            }
        }
    }

    if (confirmDelete) {
        ConfirmDialog(
            title = "ゴミ箱に移しますか？",
            text = "「${account.displayName}」をゴミ箱に移します。30日間は復元できます。",
            confirmLabel = "ゴミ箱に移す",
            danger = true,
            onConfirm = {
                confirmDelete = false
                onDelete(account.id)
            },
            onDismiss = { confirmDelete = false },
        )
    }
    if (confirmPurge) {
        ConfirmDialog(
            title = "完全に削除しますか？",
            text = "このアカウントは復元できません。同期中の他の端末からも消えます。",
            confirmLabel = "完全に削除",
            danger = true,
            onConfirm = {
                confirmPurge = false
                onPurge(account.id)
            },
            onDismiss = { confirmPurge = false },
        )
    }
}

@Composable
private fun RecoveryCodesCard(
    account: Account,
    codesText: String,
    onCodesText: (String) -> Unit,
    onSaveCodes: (List<RecoveryCode>) -> Unit,
    onCopy: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    ZekeyCard {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            SectionTitle("バックアップコード")
            MiniBadge("未使用 ${account.unusedRecoveryCodes} / ${account.recoveryCodes?.size ?: 0}")
        }
        MutedText("サービス発行の予備コードを控えておけます（この端末の中だけに保存されます）。")
        if (account.recoveryCodes.isNullOrEmpty()) {
            MutedText("まだ登録されていません。")
        }
        account.recoveryCodes.orEmpty().forEach { code ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Checkbox(
                    checked = code.used,
                    onCheckedChange = { checked ->
                        onSaveCodes(
                            account.recoveryCodes.orEmpty().map {
                                if (it.id == code.id) it.copy(used = checked) else it
                            },
                        )
                    },
                )
                Text(
                    code.code,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.weight(1f),
                    color = if (code.used) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                )
                IconButton(onClick = { onCopy(code.code) }) {
                    Icon(
                        Icons.Filled.Check,
                        contentDescription = "コピー",
                        modifier = Modifier.size(18.dp),
                    )
                }
                IconButton(onClick = {
                    onSaveCodes(account.recoveryCodes.orEmpty().filterNot { it.id == code.id })
                }) {
                    Icon(
                        Icons.Filled.Clear,
                        contentDescription = "削除",
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
        }
        TextButton(onClick = { expanded = !expanded }) {
            Text(if (expanded) "一括入力を閉じる" else "コードを一括追加")
        }
        AnimatedVisibility(visible = expanded) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = codesText,
                    onValueChange = onCodesText,
                    label = { Text("改行・カンマ・空白区切り") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = {
                        // 既にあるコードは id と used を引き継ぐ（保存のたびに「未使用」に戻さない）。
                        val existing = account.recoveryCodes.orEmpty()
                        val parsed = codesText.split('\n', ',', ' ', '\t')
                            .map { it.trim() }
                            .filter { it.isNotEmpty() && it.length <= 128 }
                            .take(50)
                            .map { text ->
                                existing.firstOrNull { it.code == text } ?: RecoveryCode(UUID.randomUUID().toString(), text, false)
                            }
                        onSaveCodes(parsed)
                        expanded = false
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("保存")
                }
            }
        }
    }
}
