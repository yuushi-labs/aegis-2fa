/**
 * アプリ設定。秘密情報は持たない。
 */

export type ThemeMode = 'system' | 'light' | 'dark';

export type AutoLockMinutes = 1 | 5 | 15 | 30 | 0;

/** 一覧の並べ替え（選択は端末に保存する）。 */
export type SortMode = 'manual' | 'usage' | 'name';

export type Settings = {
  theme: ThemeMode;
  autoLockMinutes: AutoLockMinutes;
  lockOnHide: boolean;
  /** -2〜+2 ステップ */
  clockSkew: number;
  clearClipboard: boolean;
  announceCodes: boolean;
  language: 'ja' | 'en' | 'auto';
  /** 一覧の並べ替え */
  sortMode: SortMode;
};

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  autoLockMinutes: 5,
  lockOnHide: false,
  clockSkew: 0,
  clearClipboard: true,
  announceCodes: false,
  language: 'auto',
  sortMode: 'manual',
};

export const AUTO_LOCK_OPTIONS: readonly AutoLockMinutes[] = [1, 5, 15, 30, 0];
export const SORT_MODE_OPTIONS: readonly SortMode[] = ['manual', 'usage', 'name'];

export function normalizeSettings(value: unknown): Settings {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_SETTINGS };
  const raw = value as Partial<Record<keyof Settings, unknown>>;
  const autoLock = AUTO_LOCK_OPTIONS.includes(raw.autoLockMinutes as AutoLockMinutes)
    ? (raw.autoLockMinutes as AutoLockMinutes)
    : DEFAULT_SETTINGS.autoLockMinutes;
  const skew = typeof raw.clockSkew === 'number' ? Math.max(-2, Math.min(2, Math.round(raw.clockSkew))) : 0;
  return {
    theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'system',
    autoLockMinutes: autoLock,
    lockOnHide: raw.lockOnHide === true,
    clockSkew: skew,
    clearClipboard: raw.clearClipboard !== false,
    announceCodes: raw.announceCodes === true,
    language: raw.language === 'ja' || raw.language === 'en' ? raw.language : 'auto',
    sortMode: SORT_MODE_OPTIONS.includes(raw.sortMode as SortMode)
      ? (raw.sortMode as SortMode)
      : DEFAULT_SETTINGS.sortMode,
  };
}
