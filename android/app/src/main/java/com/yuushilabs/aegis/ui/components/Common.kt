package com.yuushilabs.aegis.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** 1px の境界線と弱い影のカード（Web 版の見た目に合わせる）。 */
@Composable
fun AegisCard(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val base = if (onClick == null) modifier else modifier.clickable(onClick = onClick)
    Card(
        modifier = base.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.35f)),
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            content()
        }
    }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = MaterialTheme.typography.titleMedium,
        color = MaterialTheme.colorScheme.onSurface,
        modifier = modifier,
    )
}

@Composable
fun MutedText(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier,
    )
}

/** 行の左右ラベル（詳細画面の項目）。 */
@Composable
fun DetailRow(label: String, value: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.End,
            modifier = Modifier.padding(start = 12.dp),
        )
    }
}

/** 6 桁を 3+3 で区切る等幅表示。 */
@Composable
fun CodeText(
    code: String,
    modifier: Modifier = Modifier,
    fontSize: Int = 30,
    color: Color = MaterialTheme.colorScheme.onSurface,
) {
    val grouped = if (code.length == 6) "${code.substring(0, 3)} ${code.substring(3)}" else code
    Text(
        text = grouped,
        modifier = modifier,
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Medium,
        fontSize = fontSize.sp,
        letterSpacing = 1.sp,
        color = color,
        textAlign = TextAlign.Start,
    )
}

/**
 * 残り時間の円形ゲージ。100ms ごとの値で滑らかに減る。
 * 残り 5 秒以下は警告色（テラコッタ→赤）にして、数字も目立たせる。
 */
@Composable
fun RemainingRing(
    remainingMillis: Long,
    periodMillis: Long,
    modifier: Modifier = Modifier,
    size: Int = 26,
) {
    val safePeriod = if (periodMillis <= 0) 1L else periodMillis
    val target = (remainingMillis.toFloat() / safePeriod.toFloat()).coerceIn(0f, 1f)
    val fraction by animateFloatAsState(
        targetValue = target,
        animationSpec = tween(durationMillis = 200, easing = LinearEasing),
        label = "remaining-ring",
    )
    val colorTarget = when {
        remainingMillis <= 5_000 -> MaterialTheme.colorScheme.error
        remainingMillis <= 10_000 -> MaterialTheme.colorScheme.secondary
        else -> MaterialTheme.colorScheme.primary
    }
    val color by animateColorAsState(colorTarget, label = "remaining-color")
    Canvas(modifier = modifier.size(size.dp)) {
        val stroke = 3.dp.toPx()
        drawArc(
            color = color.copy(alpha = 0.18f),
            startAngle = -90f,
            sweepAngle = 360f,
            useCenter = false,
            style = Stroke(stroke),
        )
        drawArc(
            color = color,
            startAngle = -90f,
            sweepAngle = 360f * fraction,
            useCenter = false,
            style = Stroke(stroke, cap = StrokeCap.Round),
        )
    }
}

/** 小さな状態ピル（同期済み・未送信・ローカルのみなど）。 */
@Composable
fun StatusPill(
    text: String,
    color: Color,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
) {
    val base = if (onClick == null) modifier else modifier.clickable(onClick = onClick)
    Surface(
        modifier = base,
        shape = RoundedCornerShape(999.dp),
        color = color.copy(alpha = 0.14f),
        border = BorderStroke(1.dp, color.copy(alpha = 0.35f)),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Box(modifier = Modifier.size(6.dp).background(color, CircleShape))
            Text(text, style = MaterialTheme.typography.labelSmall, color = color)
        }
    }
}

/** 小さなアイコンバッジ（ピン・メモ・未使用コードなど）。 */
@Composable
fun MiniBadge(text: String, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(999.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
    ) {
        Text(
            text,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
        )
    }
}

/** issuer から決まった色のイニシャルアバター（外部 favicon は取りに行かない）。 */
@Composable
fun IssuerAvatar(name: String, modifier: Modifier = Modifier, size: Int = 40) {
    val palette = listOf(
        Color(0xFF1F4C4A),
        Color(0xFFB4593A),
        Color(0xFF5B5A86),
        Color(0xFF6B7A3A),
        Color(0xFF8A4B63),
        Color(0xFF3E6076),
    )
    val index = (name.hashCode().let { if (it == Int.MIN_VALUE) 0 else kotlin.math.abs(it) }) % palette.size
    val initial = name.trim().take(1).uppercase().ifEmpty { "?" }
    Box(
        modifier = modifier
            .size(size.dp)
            .background(palette[index], CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(initial, color = Color(0xFFFDFAF4), fontWeight = FontWeight.SemiBold, fontSize = (size / 2.4).sp)
    }
}

@Composable
fun ConfirmDialog(
    title: String,
    text: String,
    confirmLabel: String = "OK",
    dismissLabel: String = "やめる",
    danger: Boolean = false,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, style = MaterialTheme.typography.headlineSmall) },
        text = { Text(text, style = MaterialTheme.typography.bodyMedium) },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(confirmLabel, color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(dismissLabel) } },
    )
}

@Composable
fun BusyOverlay(visible: Boolean, label: String = "処理中…") {
    if (!visible) return
    Box(modifier = Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
            Text(label, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
fun ErrorBanner(text: String, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.errorContainer,
    ) {
        Text(
            text = text,
            modifier = Modifier.padding(12.dp),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onErrorContainer,
        )
    }
}

/** パスワード・秘密鍵の表示切替（material-icons-core に目のアイコンが無いので文字で出す）。 */
@Composable
fun VisibilityToggle(revealed: Boolean, onToggle: () -> Unit) {
    TextButton(onClick = onToggle) {
        Text(
            if (revealed) "隠す" else "表示",
            style = MaterialTheme.typography.labelMedium,
        )
    }
}

/** 設定などで項目の区切りに使う細い線。 */
@Composable
fun ThinDivider(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(MaterialTheme.colorScheme.outline.copy(alpha = 0.25f)),
    )
}

@Composable
fun SpacerWidth(width: Int) {
    Box(modifier = Modifier.width(width.dp))
}
