/**
 * 表示用の整形ヘルパ。
 */

/** 6 桁 → "123 456"、8 桁 → "1234 5678"。 */
export function formatCode(code: string): string {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  const mid = Math.ceil(code.length / 2);
  return `${code.slice(0, mid)} ${code.slice(mid)}`;
}

/** イニシャル 1〜2 文字。 */
export function initials(issuer: string, label: string): string {
  const source = (issuer.trim() !== '' ? issuer : label).trim();
  if (source === '') return '?';
  const words = source.split(/[\s._-]+/).filter((w) => w !== '');
  if (words.length >= 2) {
    return `${(words[0] as string).charAt(0)}${(words[1] as string).charAt(0)}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

/** issuer から決定的な色相を作る（外部 favicon は取得しない）。 */
export function avatarHue(issuer: string, label: string): number {
  const source = (issuer !== '' ? issuer : label).toLowerCase();
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) % 360;
  }
  return hash;
}

export type AvatarTone = { background: string; color: string };

/**
 * アイボリー/チャコール基調に馴染む、彩度を落としたパレット。
 * テラコッタ〜ティール〜オリーブ〜芥子色〜藍の範囲に限定する。
 */
const AVATAR_TONES: readonly AvatarTone[] = [
  { background: '#e8efec', color: '#175a55' },
  { background: '#f6e9e1', color: '#9c4f2c' },
  { background: '#eef0e2', color: '#5a6330' },
  { background: '#f3eedd', color: '#7a6326' },
  { background: '#e6ebf0', color: '#3d5570' },
  { background: '#efe8ee', color: '#6b4468' },
  { background: '#e9eeee', color: '#3f5c5c' },
  { background: '#f4e8e4', color: '#8c4033' },
];

export function avatarTone(issuer: string, label: string): AvatarTone {
  const index = avatarHue(issuer, label) % AVATAR_TONES.length;
  return AVATAR_TONES[index] as AvatarTone;
}

/** パスワード強度の簡易推定（0〜4）。 */
export function passwordStrength(password: string): number {
  if (password.length < 8) return 0;
  let score = 0;
  if (password.length >= 12) score += 1;
  if (password.length >= 16) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  // 単語 4 つ程度の長さは強みとして扱う。
  if (password.length >= 20) score += 1;
  return Math.max(0, Math.min(4, score));
}

export function formatTime(iso: string | null, language: 'ja' | 'en'): string {
  if (iso === null) return language === 'ja' ? '未同期' : 'Never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(language === 'ja' ? 'ja-JP' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/** ファイル名に使える日時文字列（ローカル時刻）。 */
export function timestampForFilename(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Safari はクリック直後に revoke すると失敗するため遅延させる。
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
