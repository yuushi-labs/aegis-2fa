import { useEffect, useState } from 'react';
import { renderQrDataUrl } from './qr';

/**
 * QR の data URL を非同期に生成する。
 * 生成完了までは null。text が null なら何もしない。
 */
export function useQrDataUrl(text: string | null, size: number): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (text === null || text === '') {
      const reset = setTimeout(() => {
        if (!cancelled) setDataUrl(null);
      }, 0);
      return () => {
        cancelled = true;
        clearTimeout(reset);
      };
    }
    void renderQrDataUrl(text, size).then((url) => {
      if (!cancelled) setDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [text, size]);

  return dataUrl;
}
