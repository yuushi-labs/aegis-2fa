package com.yuushilabs.aegis.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** 1px の境界線と弱い影のカード（Web 版の見た目に合わせる）。 */
@Composable
fun AegisCard(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.4f)),
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

/** 6 桁を 3+3 で区切る等幅表示。 */
@Composable
fun CodeText(code: String, modifier: Modifier = Modifier, fontSize: Int = 30) {
    val grouped = if (code.length == 6) "${code.substring(0, 3)} ${code.substring(3)}" else code
    Text(
        text = grouped,
        modifier = modifier,
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Medium,
        fontSize = fontSize.sp,
        letterSpacing = 1.sp,
        color = MaterialTheme.colorScheme.onSurface,
        textAlign = TextAlign.Start,
    )
}

/** 残り時間の円形ゲージ。 */
@Composable
fun RemainingRing(
    remaining: Int,
    period: Int,
    modifier: Modifier = Modifier,
    size: Int = 26,
) {
    val fraction = if (period <= 0) 0f else remaining.toFloat() / period.toFloat()
    val color = when {
        remaining <= 5 -> MaterialTheme.colorScheme.error
        remaining <= 10 -> MaterialTheme.colorScheme.secondary
        else -> MaterialTheme.colorScheme.primary
    }
    androidx.compose.foundation.Canvas(modifier = modifier.size(size.dp)) {
        val stroke = 3.dp.toPx()
        drawArc(
            color = color.copy(alpha = 0.18f),
            startAngle = -90f,
            sweepAngle = 360f,
            useCenter = false,
            style = androidx.compose.ui.graphics.drawscope.Stroke(stroke),
        )
        drawArc(
            color = color,
            startAngle = -90f,
            sweepAngle = 360f * fraction.coerceIn(0f, 1f),
            useCenter = false,
            style = androidx.compose.ui.graphics.drawscope.Stroke(stroke, cap = androidx.compose.ui.graphics.StrokeCap.Round),
        )
    }
}

/** issuer から決まった色のイニシャルアバター（外部 favicon は取りに行かない）。 */
@Composable
fun IssuerAvatar(name: String, modifier: Modifier = Modifier) {
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
            .size(40.dp)
            .background(palette[index], CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(initial, color = Color(0xFFFDFAF4), fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
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
        shape = RoundedCornerShape(10.dp),
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
