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
  deleteToken,
  deleteVault,
  readSettings,
  readToken,
  readVault,
  resetStorageCache,
  updateSyncedRevision,
  writeSettings,
  writeToken,
  writeVault,
} from '../../src/lib/storage';
import type { VaultEnvelope } from '../../shared/types';

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
    expect(DB_VERSION).toBe(1);
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
    await writeVault(envelope(4), 3);
    await updateSyncedRevision(4);
    const read = await readVault();
    expect(read?.syncedRevision).toBe(4);
    expect(read?.envelope.revision).toBe(4);
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

  it('deleteVault は封筒とトークンの両方を消す', async () => {
    await writeVault(envelope(2), 1);
    await writeToken('token-value');
    await deleteVault();
    await expect(readVault()).resolves.toBeNull();
    await expect(readToken()).resolves.toBeNull();
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
