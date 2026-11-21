package com.yuushilabs.aegis.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import kotlinx.coroutines.launch
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

private const val RESCAN_DELAY_MS = 1_500L

/** QR の生成と画像からの読み取り。 */
object QrImages {
    fun encode(content: String, size: Int = 720): Bitmap {
        val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, size, size)
        val pixels = IntArray(matrix.width * matrix.height)
        for (y in 0 until matrix.height) {
            for (x in 0 until matrix.width) {
                pixels[y * matrix.width + x] = if (matrix.get(x, y)) 0xFF000000.toInt() else 0xFFFFFFFF.toInt()
            }
        }
        return Bitmap.createBitmap(matrix.width, matrix.height, Bitmap.Config.ARGB_8888).apply {
            setPixels(pixels, 0, matrix.width, 0, 0, matrix.width, matrix.height)
        }
    }

    fun decode(bitmap: Bitmap): String? {
        val width = bitmap.width
        val height = bitmap.height
        val pixels = IntArray(width * height)
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
        return try {
            val source = RGBLuminanceSource(width, height, pixels)
            MultiFormatReader().decode(BinaryBitmap(HybridBinarizer(source))).text
        } catch (_: Exception) {
            null
        }
    }

    suspend fun decodeUri(context: Context, uri: Uri): String? = withContext(Dispatchers.IO) {
        try {
            // 原寸で展開すると巨大な写真で OutOfMemory になるため、寸法だけ先に読んで縮小する。
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@withContext null
            var sample = 1
            while (bounds.outWidth / sample > MAX_IMAGE_EDGE || bounds.outHeight / sample > MAX_IMAGE_EDGE) {
                sample *= 2
            }
            val options = BitmapFactory.Options().apply { inSampleSize = sample }
            val input = context.contentResolver.openInputStream(uri) ?: return@withContext null
            val bitmap = input.use { BitmapFactory.decodeStream(it, null, options) } ?: return@withContext null
            decode(bitmap)
        } catch (_: Exception) {
            null
        }
    }

    /** 読み取る画像の長辺の上限（QR は十分に大きいので、これ以上は縮小して読む）。 */
    private const val MAX_IMAGE_EDGE = 2048
}

@Composable
fun QrImage(content: String, modifier: Modifier = Modifier, size: Int = 220) {
    val bitmap = remember(content) { QrImages.encode(content, 720) }
    Image(
        bitmap = bitmap.asImageBitmap(),
        contentDescription = "QR コード",
        modifier = modifier
            .size(size.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(androidx.compose.ui.graphics.Color.White)
            .padding(6.dp),
    )
}

/**
 * カメラで QR を連続読み取りする。レイアウトが決まってからカメラを割り当て、
 * 画面の向きが変わったら割り当て直す（PreviewView のサイズ 0 での失敗を避ける）。
 */
@Composable
fun QrScannerPane(
    modifier: Modifier = Modifier,
    onResult: (String) -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val configuration = LocalConfiguration.current
    val orientation = configuration.orientation

    var hasPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED,
        )
    }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        hasPermission = granted
    }
    LaunchedEffect(Unit) {
        if (!hasPermission) permissionLauncher.launch(Manifest.permission.CAMERA)
    }

    if (!hasPermission) {
        Box(modifier = modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Button(onClick = { permissionLauncher.launch(Manifest.permission.CAMERA) }) {
                Text("カメラを許可して読み取る")
            }
        }
        return
    }

    val previewView = remember { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }
    val executor = remember { Executors.newSingleThreadExecutor() }
    val handled = remember { AtomicBoolean(false) }
    var layoutReady by remember { mutableStateOf(false) }
    var provider by remember { mutableStateOf<ProcessCameraProvider?>(null) }

    DisposableEffect(Unit) {
        onDispose {
            runCatching { provider?.unbindAll() }
            executor.shutdown()
        }
    }

    LaunchedEffect(layoutReady, orientation) {
        if (!layoutReady) return@LaunchedEffect
        runCatching {
            provider?.unbindAll()
            val cameraProvider = provider ?: withContext(Dispatchers.IO) {
                ProcessCameraProvider.getInstance(context).get()
            }.also { provider = it }

            val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(executor) { proxy ->
                if (handled.get()) {
                    proxy.close()
                    return@setAnalyzer
                }
                val text = decodeProxy(proxy)
                proxy.close()
                if (text != null && handled.compareAndSet(false, true)) {
                    previewView.post { onResult(text) }
                    // 読み取った値が受け付けられなかった場合に、もう一度スキャンできるようにする。
                    previewView.postDelayed({ handled.set(false) }, RESCAN_DELAY_MS)
                }
            }
            cameraProvider.bindToLifecycle(
                lifecycleOwner,
                CameraSelector.DEFAULT_BACK_CAMERA,
                preview,
                analysis,
            )
        }.onFailure {
            handled.set(false)
        }
    }

    Box(modifier = modifier.fillMaxWidth()) {
        AndroidView(
            factory = { previewView },
            modifier = Modifier
                .fillMaxWidth()
                .size(260.dp)
                .clip(RoundedCornerShape(12.dp))
                .onGloballyPositioned { coordinates ->
                    if (!layoutReady && coordinates.size.width > 0 && coordinates.size.height > 0) {
                        layoutReady = true
                    }
                },
        )
        Text(
            text = "QR コードを枠内に写してください",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(8.dp),
        )
    }
}

/** ImageProxy の輝度面を ZXing に渡す。 */
@androidx.annotation.OptIn(androidx.camera.core.ExperimentalGetImage::class)
private fun decodeProxy(proxy: ImageProxy): String? {
    val image = proxy.image ?: return null
    val plane = image.planes.firstOrNull() ?: return null
    val buffer = plane.buffer
    val width = image.width
    val height = image.height
    val rowStride = plane.rowStride
    val pixelStride = plane.pixelStride

    // 行のパディング（rowStride）を詰めて、幅 × 高さの輝度面にする。
    val packed = ByteArray(width * height)
    val row = ByteArray(rowStride)
    for (y in 0 until height) {
        val start = y * rowStride
        if (start + rowStride > buffer.limit()) break
        buffer.position(start)
        buffer.get(row, 0, rowStride)
        for (x in 0 until width) {
            packed[y * width + x] = row[x * pixelStride]
        }
    }

    val rotated = rotateLuminance(packed, width, height, proxy.imageInfo.rotationDegrees)
    val source = PlanarYUVLuminanceSource(
        rotated.data,
        rotated.width,
        rotated.height,
        0,
        0,
        rotated.width,
        rotated.height,
        false,
    )
    return try {
        MultiFormatReader().decode(BinaryBitmap(HybridBinarizer(source))).text
    } catch (_: Exception) {
        null
    }
}

private data class Luminance(val data: ByteArray, val width: Int, val height: Int)

/** カメラの回転（0/90/180/270）に合わせて輝度面を回す。 */
private fun rotateLuminance(data: ByteArray, width: Int, height: Int, degrees: Int): Luminance {
    if (degrees == 0 || degrees == -360) return Luminance(data, width, height)
    val normalized = ((degrees % 360) + 360) % 360
    if (normalized == 0) return Luminance(data, width, height)
    return when (normalized) {
        90 -> {
            // 反時計回りに 90 度（カメラの rotationDegrees は「右に 90 度回して戻す」意味）。
            val out = ByteArray(width * height)
            for (y in 0 until height) {
                for (x in 0 until width) {
                    out[(width - 1 - x) * height + y] = data[y * width + x]
                }
            }
            Luminance(out, height, width)
        }
        180 -> {
            val out = ByteArray(width * height)
            for (y in 0 until height) {
                for (x in 0 until width) {
                    out[(height - 1 - y) * width + (width - 1 - x)] = data[y * width + x]
                }
            }
            Luminance(out, width, height)
        }
        else -> {
            val out = ByteArray(width * height)
            for (y in 0 until height) {
                for (x in 0 until width) {
                    out[x * height + (height - 1 - y)] = data[y * width + x]
                }
            }
            Luminance(out, height, width)
        }
    }
}

/** 画像ファイルから読み取るボタン。 */
@Composable
fun QrImagePickButton(
    label: String = "画像から読み取る",
    onText: (String) -> Unit,
    onError: (String) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        busy = true
        scope.launch {
            val text = QrImages.decodeUri(context, uri)
            busy = false
            if (text == null) onError("画像から QR を読み取れませんでした") else onText(text)
        }
    }
    TextButton(onClick = { launcher.launch("image/*") }, enabled = !busy) {
        Text(if (busy) "読み取り中…" else label)
    }
}
