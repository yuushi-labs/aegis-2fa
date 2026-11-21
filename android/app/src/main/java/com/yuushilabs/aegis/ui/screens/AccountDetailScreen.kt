package com.yuushilabs.aegis.ui.screens

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
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.yuushilabs.aegis.core.Account
import com.yuushilabs.aegis.core.Base32
import com.yuushilabs.aegis.core.Hotp
import com.yuushilabs.aegis.core.Otpauth
import com.yuushilabs.aegis.core.RecoveryCode
import com.yuushilabs.aegis.core.Totp
import com.yuushilabs.aegis.core.Trash
import com.yuushilabs.aegis.ui.QrImage
import com.yuushilabs.aegis.ui.components.AegisCard
import com.yuushilabs.aegis.ui.components.CodeText
import com.yuushilabs.aegis.ui.components.ConfirmDialog
import com.yuushilabs.aegis.ui.components.MutedText
import com.yuushilabs.aegis.ui.components.RemainingRing
import com.yuushilabs.aegis.ui.components.SectionTitle
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
    val context = LocalContext.current
    val now = rememberNowSeconds()
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
    var error by remember { mutableStateOf<String?>(null) }

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
    var confirmDelete by remember { mutableStateOf(false) }
    var confirmPurge by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }

    val code = remember(account, now, skew) { codeFor(account, now, skew) }
    val otpauth = remember(account) { Otpauth.build(account) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(account.displayName, maxLines = 1) },
                navigationIcon = { TextButton(onClick = onBack) { Text("戻る") } },
                actions = {
                    if (!account.isTrashed) {
                        TextButton(onClick = { editing = !editing }) { Text(if (editing) "編集をやめる" else "編集") }
                        TextButton(onClick = { menu = true }) { Text("…") }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(
                                text = { Text("otpauth:// をコピー") },
                                onClick = {
                                    menu = false
                                    onCopy(otpauth)
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("otpauth:// を再生成") },
                                onClick = {
                                    menu = false
                                    onCopy(otpauth)
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
                AegisCard {
                    SectionTitle("ゴミ箱の中")
                    MutedText("あと ${days} 日で完全に削除されます。復元すると元の場所に戻ります。")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { onRestore(account.id) }) { Text("復元する") }
                        OutlinedButton(onClick = { confirmPurge = true }) { Text("完全に削除") }
                    }
                }
            } else {
                AegisCard {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        CodeText(code, fontSize = 32)
                        if (account.isTotp) {
                            RemainingRing(Totp.secondsRemaining(now, account.period), account.period)
                            MutedText("${Totp.secondsRemaining(now, account.period)}s")
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { onCopy(code) }) { Text("コピー") }
                        if (!account.isTotp) {
                            OutlinedButton(onClick = { onAdvanceHotp(account.id) }) { Text("次のコードへ") }
                        }
                    }
                    MutedText(
                        if (account.isTotp) "${account.algorithm} / ${account.digits}桁 / ${account.period}秒"
                        else "HOTP / ${account.algorithm} / ${account.digits}桁 / counter=${account.counter}",
                    )
                }

                AegisCard {
                    SectionTitle("QR コード")
                    MutedText("この QR は otpauth:// 形式です。追加したい端末で読み取ってください。")
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                        QrImage(otpauth, size = 200)
                    }
                    TextButton(onClick = { onCopy(otpauth) }, modifier = Modifier.fillMaxWidth()) {
                        Text("otpauth:// をコピー")
                    }
                }
            }

            AegisCard {
                SectionTitle(if (editing) "編集" else "詳細")
                if (editing) {
                    OutlinedTextField(issuer, { issuer = it }, label = { Text("サービス名") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(label, { label = it }, label = { Text("アカウント名") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(
                        secret,
                        { secret = it },
                        label = { Text("秘密鍵（Base32）") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("SHA1", "SHA256", "SHA512").forEach { option ->
                            if (algorithm == option) {
                                Button(onClick = {}) { Text(option) }
                            } else {
                                OutlinedButton(onClick = { algorithm = option }) { Text(option) }
                            }
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(6, 8).forEach { option ->
                            if (digits == option) {
                                Button(onClick = {}) { Text("$option 桁") }
                            } else {
                                OutlinedButton(onClick = { digits = option }) { Text("$option 桁") }
                            }
                        }
                    }
                    if (account.isTotp) {
                        OutlinedTextField(
                            period,
                            { period = it.filter(Char::isDigit) },
                            label = { Text("周期（秒）") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    } else {
                        OutlinedTextField(
                            counter,
                            { counter = it.filter(Char::isDigit) },
                            label = { Text("カウンタ") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    OutlinedTextField(notes, { notes = it }, label = { Text("メモ") }, modifier = Modifier.fillMaxWidth())
                    if (error != null) MutedText(error!!)
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
                    ) { Text("保存") }
                } else {
                    DetailLine("サービス名", account.issuer.ifBlank { "—" })
                    DetailLine("アカウント名", account.label.ifBlank { "—" })
                    DetailLine("種別", if (account.isTotp) "TOTP" else "HOTP")
                    DetailLine("アルゴリズム", account.algorithm)
                    DetailLine("桁数", "${account.digits}")
                    if (account.isTotp) DetailLine("周期", "${account.period} 秒") else DetailLine("カウンタ", "${account.counter}")
                    DetailLine("ピン留め", if (account.pinned) "あり" else "なし")
                    DetailLine("メモ", account.notes?.ifBlank { "—" } ?: "—")
                }
            }

            if (!account.isTrashed) {
                RecoveryCodesCard(
                    account = account,
                    codesText = codesText,
                    onCodesText = { codesText = it },
                    onSaveCodes = { list ->
                        onSave(account.copy(recoveryCodes = list.ifEmpty { null }))
                    },
                    onCopy = onCopy,
                )

                AegisCard {
                    SectionTitle("削除")
                    MutedText("この操作は元に戻せません（30日間はゴミ箱から復元できます）。同期中は他の端末からも消えます。")
                    OutlinedButton(onClick = { confirmDelete = true }, modifier = Modifier.fillMaxWidth()) {
                        Text("ゴミ箱に移す", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
    }

    if (confirmDelete) {
        ConfirmDialog(
            title = "ゴミ箱に移しますか？",
            text = "「${account.displayName}」をゴミ箱に移します。",
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
private fun DetailLine(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        MutedText(label)
        Text(value, style = MaterialTheme.typography.bodyMedium)
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
    AegisCard {
        SectionTitle("バックアップコード")
        MutedText("未使用 ${account.unusedRecoveryCodes} 件 / 全 ${account.recoveryCodes?.size ?: 0} 件")
        account.recoveryCodes.orEmpty().forEach { code ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
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
                TextButton(onClick = { onCopy(code.code) }) { Text("コピー") }
                TextButton(onClick = {
                    onSaveCodes(account.recoveryCodes.orEmpty().filterNot { it.id == code.id })
                }) { Text("削除") }
            }
        }
        TextButton(onClick = { expanded = !expanded }) {
            Text(if (expanded) "一括入力を閉じる" else "コードを一括追加")
        }
        if (expanded) {
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
