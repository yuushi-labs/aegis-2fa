import { useEffect, useState } from 'react';
import { renderQrDataUrl } from './qr';

export type QrDataUrlState = {
  /** 生成できたら data URL、まだなら null */
  dataUrl: string | null;
  /** 容量超過などで生成に失敗した */
  error: boolean;
};

/**
 * QR の data URL を非同期に生成する。
 * 生成完了までは null。text が null なら何もしない。
 * 失敗（容量超過など）も状態として返し、呼び出し側で案内できるようにする。
 */
export function useQrDataUrl(text: string | null, size: number): QrDataUrlState {
  const [state, setState] = useState<QrDataUrlState>({ dataUrl: null, error: false });

  useEffect(() => {
    let cancelled = false;
    if (text === null || text === '') {
      const reset = setTimeout(() => {
        if (!cancelled) setState({ dataUrl: null, error: false });
      }, 0);
      return () => {
        cancelled = true;
        clearTimeout(reset);
      };
    }
    void renderQrDataUrl(text, size)
      .then((url) => {
        if (!cancelled) setState({ dataUrl: url, error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ dataUrl: null, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [text, size]);

  return state;
}
