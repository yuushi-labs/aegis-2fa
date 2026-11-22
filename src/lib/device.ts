/**
 * 端末（ブラウザ）の識別情報。
 *
 * 同期している端末一覧に出すため、端末ごとに 1 つの ID をローカルで作って保持する。
 * 暗号化ペイロードの中の端末一覧に載せるのは ID・名前・platform・最終同期時刻だけで、
 * 端末を特定できる情報（IP や UA そのもの）は送らない。
 *
 * 保存先は localStorage（プロファイルを切り替えても同じ端末として扱う）。
 * 使えない環境ではタブ内のメモリだけに持つ。
 */

import { bytesToBase64 } from '../../shared/encoding';
import type { SyncDevice } from '../../shared/types';

export const DEVICE_STORAGE_KEY = 'zekey.device.v1';

export type DeviceIdentity = {
  id: string;
  name: string;
  platform: string;
};

type StoredDevice = { v: 1; id: string; name?: string };

let memory: StoredDevice | null = null;

function getStore(): Storage | null {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

function readStored(): StoredDevice | null {
  const store = getStore();
  if (store === null) return memory;
  try {
    const raw = store.getItem(DEVICE_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDevice>;
    if (parsed.v !== 1 || typeof parsed.id !== 'string' || parsed.id === '') return null;
    return { v: 1, id: parsed.id, ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}) };
  } catch {
    return null;
  }
}

function writeStored(value: StoredDevice): void {
  memory = value;
  const store = getStore();
  if (store === null) return;
  try {
    store.setItem(DEVICE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // 容量超過などで保存できなくても、このタブでは動き続ける。
  }
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** この端末の ID（初回に作って以後は同じ値）。 */
export function getDeviceId(): string {
  const stored = readStored();
  if (stored !== null) return stored.id;
  const id = newId();
  writeStored({ v: 1, id });
  return id;
}

/** UA から platform を推定する（送るのはこの粗い分類だけ）。 */
export function detectPlatform(userAgent?: string): string {
  const ua = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipod/i.test(ua)) return 'iOS';
  if (/ipad/i.test(ua)) return 'iOS';
  if (/mac os x|macintosh/i.test(ua)) return 'macOS';
  if (/windows/i.test(ua)) return 'Windows';
  if (/cros/i.test(ua)) return 'ChromeOS';
  if (/linux/i.test(ua)) return 'Linux';
  return 'Unknown';
}

function detectBrowser(userAgent?: string): string {
  const ua = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  if (/edg\//i.test(ua)) return 'Edge';
  if (/opr\/|opera/i.test(ua)) return 'Opera';
  if (/firefox\//i.test(ua)) return 'Firefox';
  if (/chrome\//i.test(ua) || /crios/i.test(ua)) return 'Chrome';
  if (/safari\//i.test(ua)) return 'Safari';
  return '';
}

/** 初期値の端末名（例: 'Android (Chrome)'、判定できなければ 'Desktop'）。 */
export function guessDeviceName(userAgent?: string): string {
  const platform = detectPlatform(userAgent);
  const browser = detectBrowser(userAgent);
  const base = platform === 'Unknown' ? 'Desktop' : platform;
  return browser === '' ? base : `${base} (${browser})`;
}

/** 利用者が付けた端末名（未設定なら推定値）。 */
export function getDeviceName(): string {
  return readStored()?.name ?? guessDeviceName();
}

/** 端末名を保存する（同期のペイロードにも次の保存で反映される）。 */
export function setDeviceName(name: string): void {
  const id = getDeviceId();
  writeStored({ v: 1, id, name: name.slice(0, 64) });
}

export function getDeviceIdentity(): DeviceIdentity {
  return { id: getDeviceId(), name: getDeviceName(), platform: detectPlatform() };
}

/**
 * 端末一覧に自端末を載せ、最終同期時刻を更新する。
 * 名前は利用者が変えた最新の名前で上書きする（別端末から来た古い名前を残さない）。
 */
export function touchDevice(
  devices: readonly SyncDevice[],
  identity: DeviceIdentity,
  at: string,
): SyncDevice[] {
  const others = devices.filter((device) => device.id !== identity.id);
  return [...others, { id: identity.id, name: identity.name, platform: identity.platform, lastSyncedAt: at }].sort(
    (a, b) => a.id.localeCompare(b.id),
  );
}

/** テスト用: 端末 ID の保存を忘れる。 */
export function resetDeviceIdentity(): void {
  memory = null;
  const store = getStore();
  try {
    store?.removeItem(DEVICE_STORAGE_KEY);
  } catch {
    // 消せなくてもテストには影響しない。
  }
}
