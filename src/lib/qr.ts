/**
 * QR 生成と読み取り。
 * - 生成: qrcode ライブラリ（データ URL / canvas）
 * - 読み取り: BarcodeDetector があれば優先、無ければ jsQR
 */

import QRCode from 'qrcode';
import jsQR from 'jsqr';

export type QrMatrix = {
  size: number;
  data: Uint8Array;
};

/** otpauth URI を data URL の PNG にする。 */
export async function renderQrDataUrl(text: string, size = 240): Promise<string> {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: size,
    color: { dark: '#16181a', light: '#faf7f0' },
  });
}

export async function renderQrToCanvas(canvas: HTMLCanvasElement, text: string, size = 240): Promise<void> {
  await QRCode.toCanvas(canvas, text, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: size,
    color: { dark: '#16181a', light: '#faf7f0' },
  });
}

export async function renderQrPng(text: string, size = 512): Promise<Blob> {
  const buffer = await QRCode.toBuffer(text, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: size,
    color: { dark: '#16181a', light: '#faf7f0' },
  });
  return new Blob([new Uint8Array(buffer)], { type: 'image/png' });
}

type DetectedBarcode = { rawValue: string };
type BarcodeDetectorLike = { detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]> };
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

function getBarcodeDetector(): BarcodeDetectorCtor | null {
  const candidate = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof candidate === 'function' ? candidate : null;
}

export function hasBarcodeDetector(): boolean {
  return getBarcodeDetector() !== null;
}

function imageDataToSource(imageData: ImageData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('canvas 2d context を取得できません');
  context.putImageData(imageData, 0, 0);
  return canvas;
}

/** ImageData から QR を 1 回読み取る。見つからなければ null。 */
export async function decodeImageData(imageData: ImageData): Promise<string | null> {
  const Detector = getBarcodeDetector();
  if (Detector !== null) {
    try {
      const detector = new Detector({ formats: ['qr_code'] });
      const results = await detector.detect(imageDataToSource(imageData));
      const value = results[0]?.rawValue;
      if (typeof value === 'string' && value !== '') return value;
    } catch {
      // BarcodeDetector が失敗したら jsQR にフォールバックする。
    }
  }
  const result = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'attemptBoth',
  });
  return result?.data ?? null;
}

/** 画像ファイルから QR を読む。 */
export async function decodeImageFile(file: File): Promise<string | null> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('canvas 2d context を取得できません');
    context.drawImage(bitmap, 0, 0);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    return await decodeImageData(imageData);
  } finally {
    bitmap.close();
  }
}

export type ScannerHandle = {
  stop: () => void;
};

/** カメラで連続スキャンする。背面カメラを優先。 */
export async function startCameraScanner(
  video: HTMLVideoElement,
  onResult: (value: string) => void,
  onError: (error: Error) => void,
): Promise<ScannerHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('camera_unsupported');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', 'true');
  video.muted = true;
  await video.play();

  const canvas = document.createElement('canvas');
  let running = true;
  let rafId = 0;
  let lastScan = 0;

  const tick = (): void => {
    if (!running) return;
    const now = performance.now();
    // 毎フレーム走査すると重いので 120ms 間隔にする。
    if (now - lastScan >= 120 && video.readyState >= 2) {
      lastScan = now;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (width > 0 && height > 0) {
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (context !== null) {
          context.drawImage(video, 0, 0, width, height);
          const imageData = context.getImageData(0, 0, width, height);
          void decodeImageData(imageData)
            .then((value) => {
              if (value !== null && running) {
                running = false;
                stop();
                onResult(value);
              }
            })
            .catch((error: unknown) => {
              onError(error instanceof Error ? error : new Error('decode_failed'));
            });
        }
      }
    }
    rafId = requestAnimationFrame(tick);
  };

  function stop(): void {
    running = false;
    if (rafId !== 0) cancelAnimationFrame(rafId);
    rafId = 0;
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  }

  rafId = requestAnimationFrame(tick);
  return { stop };
}
