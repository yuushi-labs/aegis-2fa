import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { resolveLanguage, translate, type Language, type MessageKey } from '../lib/i18n';
import { useVaultStore } from '../lib/vaultStore';

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

export function useI18n(): { t: Translate; language: Language } {
  const preference = useVaultStore((state) => state.settings.language);
  const language = resolveLanguage(preference);
  const t = useCallback<Translate>((key, params) => translate(language, key, params), [language]);
  return { t, language };
}

/** テーマ（system/light/dark）を html[data-theme] に反映する。 */
export function useTheme(): void {
  const theme = useVaultStore((state) => state.settings.theme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
    }
  }, [theme]);
}

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export type Toast = {
  id: number;
  message: string;
  tone: ToastTone;
};

type ToastState = {
  toasts: Toast[];
  push: (message: string, tone?: ToastTone) => void;
  dismiss: (id: number) => void;
};

let toastSeq = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push(message, tone = 'info') {
    toastSeq += 1;
    const id = toastSeq;
    set((state) => ({ toasts: [...state.toasts.slice(-2), { id, message, tone }] }));
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    }, 3200);
  },
  dismiss(id) {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },
}));

export function useToast(): (message: string, tone?: ToastTone) => void {
  return useToastStore((state) => state.push);
}

/** 現在時刻（1 秒ごと）。時計を差し替えられるよう関数で渡す。 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Esc で発火するキーハンドラ。 */
export function useEscape(handler: () => void, enabled = true): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  }, [handler]);
  useEffect(() => {
    if (!enabled) return;
    const listener = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        ref.current();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [enabled]);
}

/** アンマウント時にクリーンアップするリソース管理。 */
export function useCleanup(fn: () => void): void {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  }, [fn]);
  useEffect(() => () => ref.current(), []);
}

export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

export function useStableCallback<T extends (...args: never[]) => unknown>(fn: T): T {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  }, [fn]);
  return useMemo(() => ((...args: never[]) => ref.current(...args)) as T, []);
}
