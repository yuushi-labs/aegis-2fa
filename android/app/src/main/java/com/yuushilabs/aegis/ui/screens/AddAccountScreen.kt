package com.yuushilabs.aegis.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.yuushilabs.aegis.core.Account
import com.yuushilabs.aegis.core.Base32
import com.yuushilabs.aegis.core.DuplicateMatch
import com.yuushilabs.aegis.core.Duplicates
import com.yuushilabs.aegis.core.Migration
import com.yuushilabs.aegis.core.MigrationEntry
import com.yuushilabs.aegis.core.MigrationException
import com.yuushilabs.aegis.core.Otpauth
import com.yuushilabs.aegis.core.OtpauthException
import com.yuushilabs.aegis.core.Totp
import com.yuushilabs.aegis.ui.QrImagePickButton
import com.yuushilabs.aegis.ui.QrScannerPane
import com.yuushilabs.aegis.ui.components.AegisCard
import com.yuushilabs.aegis.ui.components.ErrorBanner
import com.yuushilabs.aegis.ui.components.MutedText
import com.yuushilabs.aegis.ui.components.VisibilityToggle
import com.yuushilabs.aegis.ui.components.SectionTitle

private val ISSUER_SUGGESTIONS = listOf(
    "Google", "GitHub", "Discord", "X", "Amazon",
    "Microsoft", "Apple", "Steam", "Cloudflare", "Notion",
)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun AddAccountScreen(
    onBack: () -> Unit,
    onCheckDuplicates: (Account) -> List<DuplicateMatch>,
    onAdd: (Account, Boolean) -> Unit,
    onMigrationImport: (List<MigrationEntry>) -> Unit,
) {
    var tab by rememberSaveable { mutableStateOf("manual") }

    var type by rememberSaveable { mutableStateOf("totp") }
    var issuer by rememberSaveable { mutableStateOf("") }
    var label by rememberSaveable { mutableStateOf("") }
    var secret by rememberSaveable { mutableStateOf("") }
    var algorithm by rememberSaveable { mutableStateOf("SHA1") }
    var digits by rememberSaveable { mutableStateOf(6) }
    var period by rememberSaveable { mutableStateOf("30") }
    var counter by rememberSaveable { mutableStateOf("0") }
    var notes by rememberSaveable { mutableStateOf("") }
    var revealSecret by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var duplicates by remember { mutableStateOf<List<DuplicateMatch>?>(null) }

    var migrationResult by remember { mutableStateOf<com.yuushilabs.aegis.core.MigrationResult?>(null) }
    var migrationError by remember { mutableStateOf<String?>(null) }

    fun handleScan(text: String) {
        when {
            Otpauth.isMigrationUri(text) -> {
                try {
                    migrationResult = Migration.parseUri(text)
                    migrationError = null
                    tab = "migration"
                } catch (failure: MigrationException) {
                    migrationError = failure.message
                    tab = "migration"
                }
            }
            Otpauth.isOtpauthUri(text) -> {
                try {
                    val params = Otpauth.parse(text)
                    type = params.type
                    issuer = params.issuer
                    label = params.label
                    secret = params.secret
                    algorithm = params.algorithm
                    digits = params.digits
                    period = params.period.toString()
                    counter = params.counter.toString()
                    error = null
                    tab = "manual"
                } catch (failure: OtpauthException) {
                    error = failure.message
                    tab = "manual"
                }
            }
            else -> {
                error = "この QR には otpauth の情報が入っていません"
            }
        }
    }

    fun draft(): Account = Account(
        type = type,
        issuer = issuer.trim(),
        label = label.trim(),
        secret = runCatching { Base32.canonical(secret) }.getOrElse { secret },
        algorithm = algorithm,
        digits = digits,
        period = period.toIntOrNull() ?: 30,
        counter = counter.toLongOrNull() ?: 0L,
        notes = notes.trim().ifEmpty { null },
    )

    fun submit() {
        val normalized = runCatching { Base32.canonical(secret) }.getOrNull()
        val periodValue = period.toIntOrNull() ?: 30
        error = when {
            normalized.isNullOrEmpty() -> "秘密鍵が正しい Base32 ではありません"
            issuer.isBlank() && label.isBlank() -> "サービス名かアカウント名を入れてください"
            type == "totp" && periodValue !in Totp.MIN_PERIOD..Totp.MAX_PERIOD ->
                "周期は ${Totp.MIN_PERIOD}〜${Totp.MAX_PERIOD} 秒にしてください"
            else -> null
        }
        if (error != null) return
        val candidate = draft().copy(secret = normalized!!, period = periodValue)
        val matches = onCheckDuplicates(candidate)
        if (matches.isNotEmpty()) {
            duplicates = matches
        } else {
            onAdd(candidate, false)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                title = { Text("アカウントを追加") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = "戻る")
                    }
                },
            )
        },
        bottomBar = {
            if (tab == "manual") {
                Surface(color = MaterialTheme.colorScheme.background, tonalElevation = 2.dp) {
                    Button(
                        onClick = { submit() },
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                    ) { Text("追加する") }
                }
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                TabChip("手入力", "manual", tab) { tab = it }
                TabChip("QR スキャン", "qr", tab) { tab = it }
                TabChip("移行", "migration", tab) { tab = it }
            }

            if (error != null) ErrorBanner(error!!)

            when (tab) {
                "qr" -> {
                    AegisCard {
                        SectionTitle("QR コードを読み取る")
                        MutedText("Google Authenticator などの QR を写してください。otpauth-migration の QR は移行タブで読み込みます。")
                        QrScannerPane(onResult = { handleScan(it) })
                        QrImagePickButton(
                            label = "画像から読み取る",
                            onText = { handleScan(it) },
                            onError = { error = it },
                        )
                    }
                }

                "migration" -> {
                    AegisCard {
                        SectionTitle("Google Authenticator から移行")
                        MutedText("「QR を読み取る」で出る移行 QR（otpauth-migration://）を読み取ります。")
                        QrScannerPane(onResult = { handleScan(it) })
                        QrImagePickButton(
                            label = "画像から読み取る",
                            onText = { handleScan(it) },
                            onError = { migrationError = it },
                        )
                        migrationError?.let { ErrorBanner(it) }
                        migrationResult?.let { result ->
                            MutedText("取り込めるアカウント: ${result.entries.size} 件")
                            if (result.skipped > 0) {
                                MutedText("スキップ: ${result.skipped} 件（${result.skipReasons.joinToString(" / ")}）")
                            }
                            result.entries.take(20).forEach { entry ->
                                MutedText("・${entry.issuer.ifBlank { entry.name }} ${entry.labelOrName()} (${entry.algorithm}/${entry.digits})")
                            }
                            Button(
                                onClick = { onMigrationImport(result.entries) },
                                enabled = result.entries.isNotEmpty(),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text("${result.entries.size} 件を取り込む")
                            }
                        }
                    }
                }

                else -> {
                    AegisCard {
                        SectionTitle("種別")
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            FilterChip(selected = type == "totp", onClick = { type = "totp" }, label = { Text("時間ベース（TOTP）") })
                            FilterChip(selected = type == "hotp", onClick = { type = "hotp" }, label = { Text("カウンタ（HOTP）") })
                        }
                    }

                    AegisCard {
                        SectionTitle("サービス")
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            ISSUER_SUGGESTIONS.forEach { name ->
                                AssistChip(onClick = { issuer = name }, label = { Text(name) })
                            }
                        }
                        OutlinedTextField(
                            value = issuer,
                            onValueChange = { issuer = it },
                            label = { Text("サービス名（例: GitHub）") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = label,
                            onValueChange = { label = it },
                            label = { Text("アカウント名（メールなど）") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }

                    AegisCard {
                        SectionTitle("秘密鍵")
                        MutedText("Base32 の秘密鍵を貼り付けてください（otpauth:// URI の自動分解はしません）。")
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
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf("SHA1", "SHA256", "SHA512").forEach { option ->
                                FilterChip(
                                    selected = algorithm == option,
                                    onClick = { algorithm = option },
                                    label = { Text(option) },
                                )
                            }
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            FilterChip(selected = digits == 6, onClick = { digits = 6 }, label = { Text("6 桁") })
                            FilterChip(selected = digits == 8, onClick = { digits = 8 }, label = { Text("8 桁") })
                        }
                        if (type == "totp") {
                            OutlinedTextField(
                                value = period,
                                onValueChange = { period = it.filter(Char::isDigit) },
                                label = { Text("周期（秒・通常 30）") },
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Next),
                                modifier = Modifier.fillMaxWidth(),
                            )
                        } else {
                            OutlinedTextField(
                                value = counter,
                                onValueChange = { counter = it.filter(Char::isDigit) },
                                label = { Text("カウンタ") },
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Next),
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                        OutlinedTextField(
                            value = notes,
                            onValueChange = { notes = it },
                            label = { Text("メモ（任意）") },
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                            minLines = 2,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
        }
    }

    duplicates?.let { matches ->
        AlertDialog(
            onDismissRequest = { duplicates = null },
            title = { Text("同じアカウントがあります") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    matches.forEach { match ->
                        Text("・${match.account.displayName}（${match.reasons.joinToString(" / ") { Duplicates.describe(it) }}）")
                    }
                    MutedText("このまま追加することもできます。")
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    duplicates = null
                    onAdd(draft(), true)
                }) { Text("それでも追加する") }
            },
            dismissButton = { TextButton(onClick = { duplicates = null }) { Text("やめる") } },
        )
    }
}

@Composable
private fun TabChip(label: String, value: String, current: String, onSelect: (String) -> Unit) {
    FilterChip(selected = current == value, onClick = { onSelect(value) }, label = { Text(label) })
}

private fun MigrationEntry.labelOrName(): String = name.ifBlank { "(名前なし)" }
