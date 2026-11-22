/**
 * 端末識別（localStorage）の単体テスト。
 *
 * 旧名（Aegis 2FA）のキーに残った端末 ID・端末名を引き継ぐことと、
 * 保存が使えない環境でも動くことを確かめる。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_STORAGE_KEY,
  getDeviceId,
  getDeviceIdentity,
  getDeviceName,
  resetDeviceIdentity,
  setDeviceName,
} from '../../src/lib/device';

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage());
  resetDeviceIdentity();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetDeviceIdentity();
});

describe('端末識別', () => {
  it('初回は ID を作って以後は同じ値を返す', () => {
    const id = getDeviceId();
    expect(id).not.toBe('');
    expect(getDeviceId()).toBe(id);
    expect(globalThis.localStorage.getItem(DEVICE_STORAGE_KEY)).toContain(id);
  });

  it('保存した端末名を使う', () => {
    setDeviceName('ゆうしの Pixel');
    expect(getDeviceName()).toBe('ゆうしの Pixel');
    expect(getDeviceIdentity().name).toBe('ゆうしの Pixel');
  });

  it('旧名（aegis.device.v1）の ID と名前を引き継いで新しいキーへ移す', () => {
    globalThis.localStorage.setItem(
      'aegis.device.v1',
      JSON.stringify({ v: 1, id: 'legacy-device-id', name: '旧端末名' }),
    );

    const identity = getDeviceIdentity();
    expect(identity.id).toBe('legacy-device-id');
    expect(identity.name).toBe('旧端末名');
    expect(globalThis.localStorage.getItem('aegis.device.v1')).toBeNull();
    expect(globalThis.localStorage.getItem(DEVICE_STORAGE_KEY)).toContain('legacy-device-id');
  });

  it('壊れた旧キーは無視して新しい ID を作る', () => {
    globalThis.localStorage.setItem('aegis.device.v1', '{not json');
    const id = getDeviceId();
    expect(id).not.toBe('');
    expect(id).not.toBe('legacy-device-id');
  });

  it('localStorage が使えなくても ID を返せる（タブ内メモリ）', () => {
    vi.stubGlobal('localStorage', undefined);
    const id = getDeviceId();
    expect(id).not.toBe('');
    expect(getDeviceId()).toBe(id);
  });
});
