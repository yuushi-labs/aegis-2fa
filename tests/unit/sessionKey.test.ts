/**
 * 「自動ロック：なし」のセッション継続（sessionStorage の DEK）の単体テスト。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToBase64 } from '../../shared/encoding';
import {
  SESSION_DEK_KEY,
  clearSessionDek,
  envelopeFingerprint,
  hasSessionDek,
  readSessionDek,
  saveSessionDek,
} from '../../src/lib/sessionKey';
import type { VaultEnvelope } from '../../shared/types';

function envelope(overrides: Partial<VaultEnvelope> = {}): VaultEnvelope {
  return {
    format: 'aegis-vault',
    version: 1,
    kdf: { name: 'PBKDF2-SHA256', iterations: 600_000, salt: 'c2FsdA==' },
    wrappedKey: { iv: 'aXY=', ciphertext: 'd3JhcHBlZA==' },
    data: { iv: 'ZGF0YQ==', ciphertext: 'ZGF0YQ==' },
    verifier: 'dmVyaWZpZXI=',
    revision: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

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

const DEK = new Uint8Array(32).fill(7);

beforeEach(() => {
  vi.stubGlobal('sessionStorage', fakeStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('セッション継続用の DEK', () => {
  it('保存した DEK を同じ封筒で読み戻せる', () => {
    const target = envelope();
    expect(saveSessionDek(target, DEK)).toBe(true);
    expect(readSessionDek(target)).toEqual(DEK);
    expect(hasSessionDek(target)).toBe(true);
  });

  it('封筒が変わったら（パスワード変更など）使わない', () => {
    expect(saveSessionDek(envelope(), DEK)).toBe(true);
    const rewrapped = envelope({ wrappedKey: { iv: 'bmV3', ciphertext: 'bmV3' } });
    expect(readSessionDek(rewrapped)).toBeNull();
    // 使えないものは消す。
    expect(globalThis.sessionStorage.getItem(SESSION_DEK_KEY)).toBeNull();
  });

  it('パスワード欄は保存しない（DEK と指紋だけ）', () => {
    expect(saveSessionDek(envelope(), DEK)).toBe(true);
    const raw = globalThis.sessionStorage.getItem(SESSION_DEK_KEY) ?? '';
    expect(raw).toContain('"v":1');
    expect(raw).not.toContain('password');
    expect(raw).not.toContain('correct-horse');
  });

  it('長さの違う DEK は保存しない', () => {
    expect(saveSessionDek(envelope(), new Uint8Array(16))).toBe(false);
    expect(globalThis.sessionStorage.getItem(SESSION_DEK_KEY)).toBeNull();
  });

  it('壊れた値は消して null を返す', () => {
    globalThis.sessionStorage.setItem(SESSION_DEK_KEY, '{not json');
    expect(readSessionDek(envelope())).toBeNull();
    expect(globalThis.sessionStorage.getItem(SESSION_DEK_KEY)).toBeNull();

    globalThis.sessionStorage.setItem(SESSION_DEK_KEY, JSON.stringify({ v: 2, dek: 'x', fingerprint: 'y' }));
    expect(readSessionDek(envelope())).toBeNull();

    const target = envelope();
    globalThis.sessionStorage.setItem(
      SESSION_DEK_KEY,
      JSON.stringify({ v: 1, fingerprint: envelopeFingerprint(target), dek: 'AAAA' }),
    );
    expect(readSessionDek(target)).toBeNull();
    expect(globalThis.sessionStorage.getItem(SESSION_DEK_KEY)).toBeNull();
  });

  it('clearSessionDek で消える', () => {
    expect(saveSessionDek(envelope(), DEK)).toBe(true);
    clearSessionDek();
    expect(globalThis.sessionStorage.getItem(SESSION_DEK_KEY)).toBeNull();
    expect(readSessionDek(envelope())).toBeNull();
  });

  it('旧名（aegis.session.dek.v1）の DEK を読み継いで新しいキーへ移す', () => {
    const target = envelope();
    const legacy = JSON.stringify({ v: 1, fingerprint: envelopeFingerprint(target), dek: bytesToBase64(DEK) });
    globalThis.sessionStorage.setItem('aegis.session.dek.v1', legacy);

    expect(readSessionDek(target)).toEqual(DEK);
    expect(globalThis.sessionStorage.getItem('aegis.session.dek.v1')).toBeNull();
    expect(globalThis.sessionStorage.getItem(SESSION_DEK_KEY)).not.toBeNull();
  });

  it('旧キーの値も clearSessionDek で消える（ロック後に旧キーから復帰できない）', () => {
    const target = envelope();
    globalThis.sessionStorage.setItem(
      'aegis.session.dek.v1',
      JSON.stringify({ v: 1, fingerprint: envelopeFingerprint(target), dek: bytesToBase64(DEK) }),
    );
    globalThis.sessionStorage.setItem(
      'aegis.session.dek.v1.work',
      JSON.stringify({ v: 1, fingerprint: envelopeFingerprint(target), dek: bytesToBase64(DEK) }),
    );

    clearSessionDek();
    expect(globalThis.sessionStorage.getItem('aegis.session.dek.v1')).toBeNull();
    expect(globalThis.sessionStorage.getItem('aegis.session.dek.v1.work')).toBeNull();
  });

  it('sessionStorage が無い環境では何もしない', () => {
    vi.stubGlobal('sessionStorage', undefined);
    expect(saveSessionDek(envelope(), DEK)).toBe(false);
    expect(readSessionDek(envelope())).toBeNull();
    expect(() => clearSessionDek()).not.toThrow();
  });

  it('sessionStorage が例外を投げても落ちない', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    vi.stubGlobal('sessionStorage', throwing as unknown as Storage);
    expect(saveSessionDek(envelope(), DEK)).toBe(false);
    expect(readSessionDek(envelope())).toBeNull();
    expect(() => clearSessionDek()).not.toThrow();
  });
});
