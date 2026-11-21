package com.yuushilabs.aegis.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.yuushilabs.aegis.core.Crypto
import com.yuushilabs.aegis.data.RepoState
import com.yuushilabs.aegis.ui.components.AegisCard
import com.yuushilabs.aegis.ui.components.ErrorBanner
import com.yuushilabs.aegis.ui.components.MutedText
import com.yuushilabs.aegis.ui.components.SectionTitle

/** 初回起動: マスターパスワードの設定。 */
@Composable
fun SetupScreen(
    busy: Boolean,
    onCreate: (password: String, confirm: String, name: String, sync: Boolean) -> Unit,
) {
    var password by rememberSaveable { mutableStateOf("") }
    var confirm by rememberSaveable { mutableStateOf("") }
    var vaultName by rememberSaveable { mutableStateOf("メイン") }
    var enableSync by rememberSaveable { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .imePadding()
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Spacer(Modifier.height(24.dp))
        Text("Aegis 2FA", style = MaterialTheme.typography.headlineLarge)
        MutedText("秘密鍵はこの端末の外へ出ません。サーバーに置かれるのは暗号文だけです。")

        AegisCard {
            SectionTitle("マスターパスワード")
            MutedText("${Crypto.MIN_PASSWORD_LENGTH}文字以上。忘れると復旧できません（保存しません）。")
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("パスワード") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = confirm,
                onValueChange = { confirm = it },
                label = { Text("パスワード（確認）") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth(),
            )
            PasswordStrength(password)
        }

        AegisCard {
            SectionTitle("ボルト名")
            OutlinedTextField(
                value = vaultName,
                onValueChange = { vaultName = it },
                label = { Text("表示名（例: メイン）") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("ゼロ知識同期を使う", style = MaterialTheme.typography.bodyLarge)
                    MutedText("接続先: https://yuushi0911.xsrv.jp/aegis")
                }
                Switch(checked = enableSync, onCheckedChange = { enableSync = it })
            }
            MutedText("オフにすると、この端末だけで使います（一切送信しません）。あとから設定で接続できます。")
        }

        if (error != null) ErrorBanner(error!!)

        Button(
            onClick = {
                error = when {
                    password.length < Crypto.MIN_PASSWORD_LENGTH ->
                        "パスワードは${Crypto.MIN_PASSWORD_LENGTH}文字以上にしてください"
                    password != confirm -> "パスワードが一致しません"
                    else -> {
                        onCreate(password, confirm, vaultName, enableSync)
                        null
                    }
                }
            },
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (busy) "作成中…" else "ボルトを作成する")
        }
        MutedText("スクリーンショットには認証コードが写ります。共有に注意してください。")
    }
}

@Composable
private fun PasswordStrength(password: String) {
    val score = when {
        password.isEmpty() -> 0
        password.length >= 16 -> 3
        password.length >= 12 -> 2
        else -> 1
    }
    val label = when (score) {
        0 -> ""
        1 -> "短すぎます"
        2 -> "長さは十分です（記号を混ぜるとより安全）"
        else -> "強いパスワードです"
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        repeat(3) { index ->
            val active = score > index
            Box(
                modifier = Modifier
                    .weight(1f)
                    .height(6.dp)
                    .background(
                        if (active) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.outline.copy(alpha = 0.3f),
                        RoundedCornerShape(3.dp),
                    ),
            )
        }
    }
    if (label.isNotEmpty()) MutedText(label)
}

/** ロック画面（解錠）。 */
@Composable
fun LockScreen(
    state: RepoState,
    busy: Boolean,
    onUnlock: (String) -> Unit,
    onBiometric: () -> Unit,
    onSwitchProfile: (String) -> Unit,
    biometricAvailable: Boolean,
) {
    var password by rememberSaveable { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    var profileMenu by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .imePadding()
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Spacer(Modifier.height(40.dp))
        Text(state.vaultName, style = MaterialTheme.typography.headlineLarge)
        MutedText("マスターパスワードで解錠します。")

        AegisCard {
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("マスターパスワード") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { onUnlock(password) }),
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(focus),
            )
            Button(
                onClick = { onUnlock(password) },
                enabled = !busy && password.isNotEmpty(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (busy) "確認中…" else "解錠")
            }
            if (state.biometricEnabled && biometricAvailable) {
                OutlinedButton(onClick = onBiometric, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                    Text("指紋 / 顔で解錠")
                }
            }
            if (busy) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.Center,
                ) {
                    CircularProgressIndicator(modifier = Modifier.height(18.dp))
                }
            }
        }

        if (state.profiles.size > 1) {
            AegisCard {
                SectionTitle("ボルトの切替")
                MutedText("いまは「${state.vaultName}」。別のボルトはそれぞれのパスワードで解錠します。")
                OutlinedButton(onClick = { profileMenu = true }, modifier = Modifier.fillMaxWidth()) {
                    Text("ボルトを選ぶ")
                }
                DropdownMenu(expanded = profileMenu, onDismissRequest = { profileMenu = false }) {
                    state.profiles.forEach { profile ->
                        DropdownMenuItem(
                            text = { Text(profile.name) },
                            onClick = {
                                profileMenu = false
                                onSwitchProfile(profile.id)
                            },
                        )
                    }
                }
            }
        }

        MutedText(
            "パスワードを忘れた場合、この端末では復旧できません。同期を使っている場合は、別端末のパスワードで入れます。",
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            "スクリーンショット・画面録画には認証コードが写ります。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Start,
        )
        LaunchedEffectFocus(focus)
    }
}

@Composable
private fun LaunchedEffectFocus(focus: FocusRequester) {
    androidx.compose.runtime.LaunchedEffect(Unit) {
        runCatching { focus.requestFocus() }
    }
}
