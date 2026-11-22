package com.yuushilabs.zekey.ui.update

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yuushilabs.zekey.ui.components.ZekeyCard
import com.yuushilabs.zekey.ui.components.MutedText
import com.yuushilabs.zekey.ui.components.SectionTitle

/** 一覧の上に出す更新のお知らせ。 */
@Composable
fun UpdateBanner(
    state: UpdateUiState,
    onDownload: () -> Unit,
    onInstall: () -> Unit,
    onSkip: () -> Unit,
    onCancel: () -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    when (state) {
        is UpdateUiState.Available -> {
            if (state.skipped) return
            ZekeyCard(modifier = modifier) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(
                        Icons.Filled.Refresh,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                        tint = MaterialTheme.colorScheme.primary,
                    )
                    SectionTitle("新しいバージョン v${state.info.versionName} があります")
                }
                if (state.info.notes.isNotBlank()) {
                    Text(
                        state.info.notes,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 4,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onDownload) { Text("今すぐ更新") }
                    TextButton(onClick = onSkip) { Text("後で") }
                }
            }
        }

        is UpdateUiState.Downloading -> ZekeyCard(modifier = modifier) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                SectionTitle("v${state.info.versionName} をダウンロード中")
            }
            val percent = state.percent
            if (percent != null) {
                LinearProgressIndicator(
                    progress = { percent / 100f },
                    modifier = Modifier.fillMaxWidth(),
                )
                MutedText("${percent}%（${megabytes(state.bytes)} / ${megabytes(state.total)}）")
            } else {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                MutedText(megabytes(state.bytes))
            }
            TextButton(onClick = onCancel) { Text("キャンセル") }
        }

        is UpdateUiState.Ready -> ZekeyCard(modifier = modifier) {
            SectionTitle("v${state.info.versionName} の準備ができました")
            MutedText("「インストール」を押すと、Android のインストーラが開きます。")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onInstall) { Text("インストール") }
                TextButton(onClick = onCancel) { Text("取り消す") }
            }
        }

        is UpdateUiState.Failed -> {
            if (!state.manual) return
            ZekeyCard(modifier = modifier) {
                SectionTitle("アップデートを確認できませんでした")
                MutedText(state.message)
                TextButton(onClick = onRetry) { Text("もう一度") }
            }
        }

        else -> Unit
    }
}

/** 設定画面の「このアプリについて」欄。 */
@Composable
fun UpdateSection(
    state: UpdateUiState,
    versionName: String,
    onCheck: () -> Unit,
    onDownload: () -> Unit,
    onInstall: () -> Unit,
    onCancel: () -> Unit,
) {
    ZekeyCard {
        SectionTitle("このアプリについて")
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Zekey 2FA $versionName", style = MaterialTheme.typography.bodyMedium)
                MutedText(
                    when (state) {
                        is UpdateUiState.Checking -> "最新版を確認しています…"
                        UpdateUiState.Latest -> "最新版を使っています。"
                        is UpdateUiState.Available ->
                            if (state.skipped) "v${state.info.versionName} に更新できます（後で）"
                            else "v${state.info.versionName} に更新できます。"
                        is UpdateUiState.Downloading -> "v${state.info.versionName} をダウンロード中…"
                        is UpdateUiState.Ready -> "v${state.info.versionName} をインストールできます。"
                        is UpdateUiState.Failed -> state.message
                        UpdateUiState.Idle -> "GitHub Releases から更新を確認できます。"
                    },
                )
            }
            if (state is UpdateUiState.Checking) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
            } else {
                OutlinedButton(onClick = onCheck) { Text("確認") }
            }
        }

        when (state) {
            is UpdateUiState.Available -> {
                if (state.info.notes.isNotBlank()) {
                    MutedText(state.info.notes)
                }
                Button(onClick = onDownload, modifier = Modifier.fillMaxWidth()) {
                    Text("v${state.info.versionName} をダウンロード")
                }
            }

            is UpdateUiState.Downloading -> {
                val percent = state.percent
                if (percent != null) {
                    LinearProgressIndicator(progress = { percent / 100f }, modifier = Modifier.fillMaxWidth())
                    MutedText("${percent}%（${megabytes(state.bytes)} / ${megabytes(state.total)}）")
                } else {
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                }
                TextButton(onClick = onCancel) { Text("キャンセル") }
            }

            is UpdateUiState.Ready -> Button(onClick = onInstall, modifier = Modifier.fillMaxWidth()) {
                Text("インストールする")
            }

            else -> Unit
        }

        MutedText("秘密鍵とマスターパスワードは端末の外へ出ません。同期で送るのは AES-256-GCM の暗号文だけです。")
        MutedText("サーバー URL は固定です（変更できません）。")
    }
}

private fun megabytes(bytes: Long): String {
    if (bytes <= 0) return "—"
    val mb = bytes / (1024.0 * 1024.0)
    return String.format(java.util.Locale.JAPAN, "%.1f MB", mb)
}
