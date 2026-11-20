import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n, useToast } from '../lib/hooks';
import { decodeImageFile, hasBarcodeDetector, startCameraScanner, type ScannerHandle } from '../lib/qr';

export type QrScanMode = 'camera' | 'image' | 'both';

export type QrScanPanelProps = {
  /** 使える読み取り手段（カメラのみ／画像のみ／両方） */
  mode: QrScanMode;
  /** 読み取った文字列を渡す。false を返すと「読み取れない」と表示する。 */
  onValue: (value: string) => boolean;
  /** 読み取れないときの文言 */
  invalidMessage: string;
  imageTestId?: string;
  videoTestId?: string;
  /** 撮影中・解析中のマウント解除を呼び出し側からも知らせる必要はない（内部で止める）。 */
};

/**
 * QR の読み取り（カメラ連続スキャン + 画像ファイル）。
 * 解釈は呼び出し側の onValue に任せ、ここでは「QR の文字列」だけを渡す。
 */
export function QrScanPanel({ mode, onValue, invalidMessage, imageTestId, videoTestId }: QrScanPanelProps) {
  const { t } = useI18n();
  const showCamera = mode !== 'image';
  const showImage = mode !== 'camera';
  const supported = typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia !== undefined;

  const videoRef = useRef<HTMLVideoElement>(null);
  const camera = useCameraScanner({ videoRef, enabled: showCamera, supported, onValue, invalidMessage });
  const image = useImageDecoder({ enabled: showImage, onValue, invalidMessage });

  return (
    <div className="flex flex-col gap-3">
      {showCamera && (
        <div>
          <p className="text-[0.86rem] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {t('qr.lead')}
          </p>
          {!supported ? (
            <p className="field-error mt-3">{t('qr.unsupported')}</p>
          ) : (
            <>
              <div
                className="mt-3 overflow-hidden rounded-lg"
                style={{
                  background: '#0d0f10',
                  aspectRatio: '4 / 3',
                  border: '1px solid var(--border)',
                  maxHeight: '46dvh',
                }}
              >
                <video
                  ref={videoRef}
                  className="h-full w-full object-cover"
                  aria-label={t('qr.lead')}
                  playsInline
                  muted
                  data-testid={videoTestId}
                />
              </div>
              {camera.error !== null && <p className="field-error mt-2">{camera.error}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {camera.active ? (
                  <button type="button" className="btn btn-secondary" onClick={camera.stop}>
                    {t('qr.stop')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void camera.start()}
                    disabled={camera.starting}
                  >
                    {camera.starting ? t('common.loading') : t('qr.start')}
                  </button>
                )}
                <span className="text-[0.72rem]" style={{ color: 'var(--text-faint)' }}>
                  {hasBarcodeDetector() ? 'BarcodeDetector' : 'jsQR'}
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {showCamera && showImage && <hr className="rule" />}

      {showImage && (
        <div>
          <p className="text-[0.86rem] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {t('qr.imageLead')}
          </p>
          <input
            type="file"
            accept="image/*"
            className="mt-3 block w-full text-[0.82rem]"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void image.decode(file);
              // 同じ画像をもう一度選べるようにする。
              event.target.value = '';
            }}
            data-testid={imageTestId}
          />
          {image.busy && (
            <p className="mt-2 flex items-center gap-2 text-[0.8rem]" style={{ color: 'var(--text-muted)' }}>
              <span className="spinner" /> {t('qr.scanning')}
            </p>
          )}
          {image.error !== null && <p className="field-error mt-2">{image.error}</p>}
        </div>
      )}
    </div>
  );
}

/** カメラで連続スキャンする部分（開始待ちの間に画面を離れた場合も確実に止める）。 */
function useCameraScanner(options: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  enabled: boolean;
  supported: boolean;
  onValue: (value: string) => boolean;
  invalidMessage: string;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const { videoRef, enabled, supported, onValue, invalidMessage } = options;
  const handleRef = useRef<ScannerHandle | null>(null);
  const startingRef = useRef(false);
  const cancelledRef = useRef(false);
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
    setActive(false);
  }, []);

  useEffect(() => {
    // StrictMode の再実行でも有効に戻す（cleanup で false のままにしない）。
    cancelledRef.current = false;
    return () => {
      // 画面を離れたら、開始待ちで後から返ってくる handle も即座に止める。
      cancelledRef.current = true;
      stop();
    };
  }, [stop]);

  async function start(): Promise<void> {
    const video = videoRef.current;
    if (!enabled || !supported || video === null || startingRef.current || active) return;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    try {
      const handle = await startCameraScanner(
        video,
        (value) => {
          stop();
          if (!onValue(value)) {
            setError(invalidMessage);
            toast(invalidMessage, 'error');
          }
        },
        (scannerError) => {
          setError(scannerError.message);
          stop();
        },
      );
      if (cancelledRef.current) {
        handle.stop();
        return;
      }
      handleRef.current?.stop();
      handleRef.current = handle;
      setActive(true);
    } catch (scannerError) {
      const name = scannerError instanceof Error ? scannerError.message : 'camera_error';
      setError(name === 'camera_unsupported' ? t('qr.unsupported') : t('qr.denied'));
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }

  return { active, starting, error, start, stop };
}

/** 画像ファイルからデコードする部分（古い結果を新しい選択に適用しない）。 */
function useImageDecoder(options: {
  enabled: boolean;
  onValue: (value: string) => boolean;
  invalidMessage: string;
}) {
  const { t } = useI18n();
  const { enabled, onValue, invalidMessage } = options;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function decode(file: File): Promise<void> {
    if (!enabled) return;
    const requestId = (requestRef.current += 1);
    const isLatest = (): boolean => requestRef.current === requestId && mountedRef.current;
    setBusy(true);
    setError(null);
    try {
      const value = await decodeImageFile(file);
      if (!isLatest()) return;
      if (value === null) {
        setError(t('migration.invalid'));
        return;
      }
      if (!onValue(value)) setError(invalidMessage);
    } catch {
      if (!isLatest()) return;
      setError(t('migration.invalid'));
    } finally {
      if (isLatest()) setBusy(false);
    }
  }

  return { busy, error, decode };
}
