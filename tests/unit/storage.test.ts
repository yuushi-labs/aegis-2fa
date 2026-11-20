/**
 * IndexedDB 永続化の単体テスト。
 * fake-indexeddb で本物の IndexedDB API を Node 上に用意し、
 * 「暗号文封筒と syncedRevision だけを保存する」ことを確かめる。
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DB_NAME,
  DB_VERSION,
  deleteAllPasskeys,
  deletePasskey,
  deleteToken,
  deleteVault,
  putPasskey,
  readPasskeys,
  readSettings,
  readToken,
  readVault,
  replacePasskeys,
  resetStorageCache,
  updateSyncedRevision,
  writeSettings,
  writeToken,
  writeVault,
} from '../../src/lib/storage';
import { bytesToBase64 } from '../../shared/encoding';
import type { PasskeyRecord, VaultEnvelope } from '../../shared/types';

function passkey(id: string, overrides: Partial<PasskeyRecord> = {}): PasskeyRecord {
  return {
    v: 1,
    id,
    name: `key ${id}`,
    createdAt: '2026-01-02T03:04:05.000Z',
    prfSalt: bytesToBase64(new Uint8Array(32).fill(1)),
    wrappedDek: { iv: bytesToBase64(new Uint8Array(12).fill(2)), ciphertext: 'd3JhcHBlZA==' },
    vaultFingerprint: 'fingerprint',
    verifier: 'dmVyaWZpZXI=',
    ...overrides,
  };
}

function envelope(revision: number): VaultEnvelope {
  return {
    format: 'aegis-vault',
    version: 1,
    kdf: { name: 'PBKDF2-SHA256', iterations: 600_000, salt: 'c2FsdA==' },
    wrappedKey: { iv: 'aXY=', ciphertext: 'd3JhcHBlZA==' },
    data: { iv: `aXY${revision}`, ciphertext: `ZGF0YQ${revision}==` },
    verifier: 'dmVyaWZpZXI=',
    revision,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  // テストごとに空の IndexedDB を作り直す（モジュール内の接続キャッシュも捨てる）。
  vi.stubGlobal('indexedDB', new IDBFactory());
  resetStorageCache();
});

describe('IndexedDB 永続化', () => {
  it('DB 名とバージョンは固定値', () => {
    expect(DB_NAME).toBe('aegis-2fa');
    // v2 でパスキー（WebAuthn PRF）の登録ストアを追加した。
    expect(DB_VERSION).toBe(2);
  });

  it('保存が無ければ null を返す', async () => {
    await expect(readVault()).resolves.toBeNull();
    await expect(readToken()).resolves.toBeNull();
    await expect(readSettings()).resolves.toBeNull();
  });

  it('封筒と syncedRevision を保存して読み戻す', async () => {
    const stored = envelope(3);
    await writeVault(stored, 2);
    const read = await readVault();
    expect(read?.envelope).toEqual(stored);
    expect(read?.syncedRevision).toBe(2);
    expect(typeof read?.savedAt).toBe('string');
    expect(Number.isNaN(Date.parse(read?.savedAt ?? ''))).toBe(false);
  });

  it('ローカル専用（syncedRevision = null）も保存できる', async () => {
    await writeVault(envelope(1), null);
    await expect(readVault()).resolves.toMatchObject({ syncedRevision: null });
  });

  it('updateSyncedRevision は封筒を変えずに同期位置だけ進める', async () => {
    const stored = envelope(4);
    await writeVault(stored, 3);
    const before = await readVault();
    await updateSyncedRevision(4);
    const after = await readVault();
    expect(after?.syncedRevision).toBe(4);
    // syncedRevision 以外（封筒の暗号文・IV・verifier・savedAt）は変わらない。
    expect(after?.envelope).toEqual(stored);
    expect(after?.savedAt).toBe(before?.savedAt);
    await updateSyncedRevision(null);
    await expect(readVault()).resolves.toMatchObject({ syncedRevision: null });
  });

  it('保存が無い状態の updateSyncedRevision は何もしない', async () => {
    await updateSyncedRevision(9);
    await expect(readVault()).resolves.toBeNull();
  });

  it('同期トークンを保存・読み出し・削除できる', async () => {
    await writeToken('token-value');
    await expect(readToken()).resolves.toBe('token-value');
    await deleteToken();
    await expect(readToken()).resolves.toBeNull();
  });

  it('deleteVault は封筒・トークン・パスキーを消す', async () => {
    await writeVault(envelope(2), 1);
    await writeToken('token-value');
    await putPasskey(passkey('cred-1'));
    await deleteVault();
    await expect(readVault()).resolves.toBeNull();
    await expect(readToken()).resolves.toBeNull();
    await expect(readPasskeys()).resolves.toEqual([]);
  });

  it('パスキーの登録を保存・読み出し・削除できる', async () => {
    await expect(readPasskeys()).resolves.toEqual([]);
    await putPasskey(passkey('cred-1'));
    await putPasskey(passkey('cred-2', { name: 'YubiKey' }));
    const stored = await readPasskeys();
    expect(stored.map((item) => item.id).sort()).toEqual(['cred-1', 'cred-2']);
    expect(stored.find((item) => item.id === 'cred-2')?.name).toBe('YubiKey');
    await deletePasskey('cred-1');
    await expect(readPasskeys()).resolves.toMatchObject([{ id: 'cred-2' }]);
  });

  it('同じ credentialId で登録し直すと上書きされる（1 人 1 件）', async () => {
    await putPasskey(passkey('cred-1', { name: 'old' }));
    await putPasskey(passkey('cred-1', { name: 'new' }));
    const stored = await readPasskeys();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.name).toBe('new');
  });

  it('replacePasskeys は丸ごと入れ替える', async () => {
    await putPasskey(passkey('cred-1'));
    await putPasskey(passkey('cred-2'));
    await replacePasskeys([passkey('cred-2', { name: 'kept' }), passkey('cred-3')]);
    const stored = await readPasskeys();
    expect(stored.map((item) => item.id).sort()).toEqual(['cred-2', 'cred-3']);
    expect(stored.find((item) => item.id === 'cred-2')?.name).toBe('kept');
    await replacePasskeys([]);
    await expect(readPasskeys()).resolves.toEqual([]);
    await deleteAllPasskeys();
    await expect(readPasskeys()).resolves.toEqual([]);
  });

  it('v1 の DB を開いてもパスキーのストアが作られる（アップグレード）', async () => {
    // DB_VERSION を 1 として開いた状態を作り、そのあと通常の接続で開き直す。
    const { openDB } = await import('idb');
    const old = await openDB('aegis-2fa', 1, {
      upgrade(db) {
        db.createObjectStore('vault', { keyPath: 'id' });
        db.createObjectStore('secrets', { keyPath: 'id' });
        db.createObjectStore('settings', { keyPath: 'id' });
      },
    });
    old.close();
    resetStorageCache();
    await putPasskey(passkey('cred-1'));
    await expect(readPasskeys()).resolves.toMatchObject([{ id: 'cred-1' }]);
  });

  it('設定は任意の値をそのまま保存する', async () => {
    await writeSettings({ theme: 'dark', autoLockMinutes: 1 });
    await expect(readSettings()).resolves.toEqual({ theme: 'dark', autoLockMinutes: 1 });
    await writeSettings('plain');
    await expect(readSettings()).resolves.toBe('plain');
  });

  it('同じ DB を開き直しても内容が残る', async () => {
    await writeVault(envelope(6), 6);
    // 接続キャッシュだけ捨てて（タブ再読み込み相当）、同じ DB から読み直す。
    resetStorageCache();
    const read = await readVault();
    expect(read?.envelope.revision).toBe(6);
    expect(read?.syncedRevision).toBe(6);
  });
});
