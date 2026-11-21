package com.yuushilabs.aegis.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Web 版と同じ落ち着いた配色（アイボリー / チャコール + 深いティール + テラコッタ）。
 * 外部フォントは読み込まず、見出しは端末のセリフ体を使う。
 */
private val Ivory = Color(0xFFF7F1E6)
private val IvorySurface = Color(0xFFFDFAF4)
private val Charcoal = Color(0xFF1E1C19)
private val CharcoalSurface = Color(0xFF2A2724)
private val Teal = Color(0xFF1F4C4A)
private val TealLight = Color(0xFF7FB3AC)
private val Terracotta = Color(0xFFB4593A)
private val TerracottaLight = Color(0xFFE0A088)
private val Ink = Color(0xFF241F1B)
private val Muted = Color(0xFF6B6259)

private val LightScheme = lightColorScheme(
    primary = Teal,
    onPrimary = Color(0xFFF7F1E6),
    primaryContainer = Color(0xFFD5E4DF),
    onPrimaryContainer = Color(0xFF10312F),
    secondary = Terracotta,
    onSecondary = Color(0xFFFDFAF4),
    secondaryContainer = Color(0xFFF3DCD2),
    onSecondaryContainer = Color(0xFF532414),
    background = Ivory,
    onBackground = Ink,
    surface = IvorySurface,
    onSurface = Ink,
    surfaceVariant = Color(0xFFEDE4D6),
    onSurfaceVariant = Muted,
    outline = Color(0xFFC9BEAC),
    error = Color(0xFF9B2C2C),
    onError = Color(0xFFFDFAF4),
)

private val DarkScheme = darkColorScheme(
    primary = TealLight,
    onPrimary = Color(0xFF0E2624),
    primaryContainer = Color(0xFF2E5D59),
    onPrimaryContainer = Color(0xFFD5E4DF),
    secondary = TerracottaLight,
    onSecondary = Color(0xFF3A1A0E),
    secondaryContainer = Color(0xFF6B3826),
    onSecondaryContainer = Color(0xFFF3DCD2),
    background = Charcoal,
    onBackground = Color(0xFFEDE6DA),
    surface = CharcoalSurface,
    onSurface = Color(0xFFEDE6DA),
    surfaceVariant = Color(0xFF3A3632),
    onSurfaceVariant = Color(0xFFC6BCAD),
    outline = Color(0xFF6B6259),
    error = Color(0xFFE79A9A),
    onError = Color(0xFF3A0F0F),
)

/** 見出しはセリフ、コードは等幅。 */
private val AegisTypography = Typography(
    headlineLarge = TextStyle(
        fontFamily = FontFamily.Serif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 30.sp,
        lineHeight = 36.sp,
    ),
    headlineMedium = TextStyle(
        fontFamily = FontFamily.Serif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 24.sp,
        lineHeight = 30.sp,
    ),
    headlineSmall = TextStyle(
        fontFamily = FontFamily.Serif,
        fontWeight = FontWeight.Medium,
        fontSize = 20.sp,
        lineHeight = 26.sp,
    ),
    titleMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 16.sp),
    bodyLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 14.sp, lineHeight = 21.sp),
    bodySmall = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 12.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Medium, fontSize = 14.sp),
)

@Composable
fun AegisTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = false,
    content: @Composable () -> Unit,
) {
    val scheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkScheme
        else -> LightScheme
    }
    MaterialTheme(colorScheme = scheme, typography = AegisTypography, content = content)
}
