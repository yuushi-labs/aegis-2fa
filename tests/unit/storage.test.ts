/**
 * IndexedDB 永続化の単体テスト。
 * fake-indexeddb で本物の IndexedDB API を Node 上に用意し、
 * 「暗号文封筒と syncedRevision だけを保存する」ことと、
 * 複数プロファイル（v3）への移行・分離を確かめる。
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DB_NAME,
  DB_VERSION,
  DEFAULT_PROFILE_ID,
  deleteAllPasskeys,
  deletePasskey,
  deleteProfileRecord,
  deleteToken,
  deleteVault,
  listProfiles,
  putPasskey,
  putProfile,
  readActiveProfileId,
  readPasskeys,
  readProfile,
  readSettings,
  readToken,
  readVault,
  replacePasskeys,
  resetStorageCache,
  updateSyncedRevision,
  writeActiveProfileId,
  writeSettings,
  writeToken,
  writeVault,
} from '../../src/lib/storage';
import { bytesToBase64 } from '../../shared/encoding';
import type { PasskeyRecord, VaultEnvelope } from '../../shared/types';

const MAIN = DEFAULT_PROFILE_ID;

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
    // DB 名は旧名のまま固定する。`/aegis/` と `/zekey/` は同じオリジンなので、
    // 名前を変えると端末に保存済みのボルトが見えなくなる（表示名ではない）。
    expect(DB_NAME).toBe('aegis-2fa');
    // v2 でパスキー、v3 でプロファイル（複数ボルト）を追加した。
    expect(DB_VERSION).toBe(3);
  });

  it('保存が無ければ null を返す', async () => {
    await expect(readVault(MAIN)).resolves.toBeNull();
    await expect(readToken(MAIN)).resolves.toBeNull();
    await expect(readSettings()).resolves.toBeNull();
  });

  it('初回に既定プロファイルと選択状態が用意される', async () => {
    const profiles = await listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.id).toBe(MAIN);
    await expect(readActiveProfileId()).resolves.toBe(MAIN);
  });

  it('封筒と syncedRevision を保存して読み戻す', async () => {
    const stored = envelope(3);
    await writeVault(MAIN, stored, 2);
    const read = await readVault(MAIN);
    expect(read?.envelope).toEqual(stored);
    expect(read?.syncedRevision).toBe(2);
    expect(typeof read?.savedAt).toBe('string');
    expect(Number.isNaN(Date.parse(read?.savedAt ?? ''))).toBe(false);
  });

  it('ローカル専用（syncedRevision = null）も保存できる', async () => {
    await writeVault(MAIN, envelope(1), null);
    await expect(readVault(MAIN)).resolves.toMatchObject({ syncedRevision: null });
  });

  it('updateSyncedRevision は封筒を変えずに同期位置だけ進める', async () => {
    const stored = envelope(4);
    await writeVault(MAIN, stored, 3);
    const before = await readVault(MAIN);
    await updateSyncedRevision(MAIN, 4);
    const after = await readVault(MAIN);
    expect(after?.syncedRevision).toBe(4);
    // syncedRevision 以外（封筒の暗号文・IV・verifier・savedAt）は変わらない。
    expect(after?.envelope).toEqual(stored);
    expect(after?.savedAt).toBe(before?.savedAt);
    await updateSyncedRevision(MAIN, null);
    await expect(readVault(MAIN)).resolves.toMatchObject({ syncedRevision: null });
  });

  it('保存が無い状態の updateSyncedRevision は何もしない', async () => {
    await updateSyncedRevision(MAIN, 9);
    await expect(readVault(MAIN)).resolves.toBeNull();
  });

  it('同期トークンを保存・読み出し・削除できる', async () => {
    await writeToken(MAIN, 'token-value');
    await expect(readToken(MAIN)).resolves.toBe('token-value');
    await deleteToken(MAIN);
    await expect(readToken(MAIN)).resolves.toBeNull();
  });

  it('deleteVault は封筒・トークン・パスキーを消す', async () => {
    await writeVault(MAIN, envelope(2), 1);
    await writeToken(MAIN, 'token-value');
    await putPasskey(MAIN, passkey('cred-1'));
    await deleteVault(MAIN);
    await expect(readVault(MAIN)).resolves.toBeNull();
    await expect(readToken(MAIN)).resolves.toBeNull();
    await expect(readPasskeys(MAIN)).resolves.toEqual([]);
  });

  it('パスキーの登録を保存・読み出し・削除できる', async () => {
    await expect(readPasskeys(MAIN)).resolves.toEqual([]);
    await putPasskey(MAIN, passkey('cred-1'));
    await putPasskey(MAIN, passkey('cred-2', { name: 'YubiKey' }));
    const stored = await readPasskeys(MAIN);
    expect(stored.map((item) => item.id).sort()).toEqual(['cred-1', 'cred-2']);
    expect(stored.find((item) => item.id === 'cred-2')?.name).toBe('YubiKey');
    await deletePasskey('cred-1', MAIN);
    await expect(readPasskeys(MAIN)).resolves.toMatchObject([{ id: 'cred-2' }]);
  });

  it('同じ credentialId で登録し直すと上書きされる（1 人 1 件）', async () => {
    await putPasskey(MAIN, passkey('cred-1', { name: 'old' }));
    await putPasskey(MAIN, passkey('cred-1', { name: 'new' }));
    const stored = await readPasskeys(MAIN);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.name).toBe('new');
  });

  it('replacePasskeys は丸ごと入れ替える', async () => {
    await putPasskey(MAIN, passkey('cred-1'));
    await putPasskey(MAIN, passkey('cred-2'));
    await replacePasskeys(MAIN, [passkey('cred-2', { name: 'kept' }), passkey('cred-3')]);
    const stored = await readPasskeys(MAIN);
    expect(stored.map((item) => item.id).sort()).toEqual(['cred-2', 'cred-3']);
    expect(stored.find((item) => item.id === 'cred-2')?.name).toBe('kept');
    await replacePasskeys(MAIN, []);
    await expect(readPasskeys(MAIN)).resolves.toEqual([]);
    await deleteAllPasskeys(MAIN);
    await expect(readPasskeys(MAIN)).resolves.toEqual([]);
  });

  it('v1 の DB を開いてもパスキーとプロファイルのストアが作られる（アップグレード）', async () => {
    // DB_VERSION を 1 として開いた状態を作り、そのあと通常の接続で開き直す。
    const { openDB } = await import('idb');
    const old = await openDB('zekey-2fa', 1, {
      upgrade(db) {
        db.createObjectStore('vault', { keyPath: 'id' });
        db.createObjectStore('secrets', { keyPath: 'id' });
        db.createObjectStore('settings', { keyPath: 'id' });
      },
    });
    old.close();
    resetStorageCache();
    await putPasskey(MAIN, passkey('cred-1'));
    await expect(readPasskeys(MAIN)).resolves.toMatchObject([{ id: 'cred-1' }]);
    await expect(listProfiles()).resolves.toMatchObject([{ id: MAIN }]);
  });

  it('設定は任意の値をそのまま保存する', async () => {
    await writeSettings({ theme: 'dark', autoLockMinutes: 1 });
    await expect(readSettings()).resolves.toEqual({ theme: 'dark', autoLockMinutes: 1 });
    await writeSettings('plain');
    await expect(readSettings()).resolves.toBe('plain');
  });

  it('同じ DB を開き直しても内容が残る', async () => {
    await writeVault(MAIN, envelope(6), 6);
    // 接続キャッシュだけ捨てて（タブ再読み込み相当）、同じ DB から読み直す。
    resetStorageCache();
    const read = await readVault(MAIN);
    expect(read?.envelope.revision).toBe(6);
    expect(read?.syncedRevision).toBe(6);
  });
});

describe('複数プロファイル', () => {
  it('追加・改名・削除ができる', async () => {
    const second = { id: 'work', name: '仕事', createdAt: '2099-02-01T00:00:00.000Z' };
    await putProfile(second);
    const profiles = await listProfiles();
    expect(profiles.map((profile) => profile.id)).toEqual([MAIN, 'work']);
    await putProfile({ ...second, name: '仕事用' });
    await expect(readProfile('work')).resolves.toMatchObject({ name: '仕事用' });
    await writeActiveProfileId('work');
    await expect(readActiveProfileId()).resolves.toBe('work');
    await deleteProfileRecord('work');
    await expect(readProfile('work')).resolves.toBeNull();
    expect((await listProfiles()).map((profile) => profile.id)).toEqual([MAIN]);
  });

  it('プロファイルごとに封筒・同期コード・パスキーが独立する', async () => {
    await putProfile({ id: 'work', name: '仕事', createdAt: '2026-02-01T00:00:00.000Z' });
    await writeVault(MAIN, envelope(1), 1);
    await writeVault('work', envelope(2), null);
    await writeToken(MAIN, 'token-main');
    await putPasskey(MAIN, passkey('cred-main'));
    await putPasskey('work', passkey('cred-work'));

    await expect(readVault(MAIN)).resolves.toMatchObject({ envelope: { revision: 1 } });
    await expect(readVault('work')).resolves.toMatchObject({ envelope: { revision: 2 } });
    await expect(readToken('work')).resolves.toBeNull();
    await expect(readPasskeys(MAIN)).resolves.toMatchObject([{ id: 'cred-main' }]);
    await expect(readPasskeys('work')).resolves.toMatchObject([{ id: 'cred-work' }]);

    // 片方の削除が、もう片方を消さない。
    await deleteVault(MAIN);
    await expect(readVault('work')).resolves.toMatchObject({ envelope: { revision: 2 } });
    await expect(readPasskeys('work')).resolves.toMatchObject([{ id: 'cred-work' }]);
  });

  it('v2 の単一ボルトを既定プロファイルへ引き継ぐ（v2 → v3 マイグレーション）', async () => {
    const { openDB } = await import('idb');
    const legacy = await openDB(DB_NAME, 2, {
      upgrade(db) {
        db.createObjectStore('vault', { keyPath: 'id' });
        db.createObjectStore('secrets', { keyPath: 'id' });
        db.createObjectStore('settings', { keyPath: 'id' });
        db.createObjectStore('passkeys', { keyPath: 'id' });
      },
    });
    await legacy.put('vault', {
      id: 'vault',
      envelope: envelope(5),
      syncedRevision: 4,
      savedAt: '2026-01-05T00:00:00.000Z',
    });
    await legacy.put('secrets', { id: 'token', token: 'legacy-token' });
    await legacy.put('passkeys', passkey('cred-legacy'));
    await legacy.put('settings', { id: 'settings', value: { theme: 'dark' } });
    legacy.close();
    resetStorageCache();

    const migrated = await readVault(MAIN);
    expect(migrated?.envelope.revision).toBe(5);
    expect(migrated?.syncedRevision).toBe(4);
    await expect(readToken(MAIN)).resolves.toBe('legacy-token');
    await expect(readPasskeys(MAIN)).resolves.toMatchObject([{ id: 'cred-legacy' }]);
    await expect(readSettings()).resolves.toEqual({ theme: 'dark' });
    await expect(listProfiles()).resolves.toMatchObject([{ id: MAIN }]);
    await expect(readActiveProfileId()).resolves.toBe(MAIN);
    // 旧キーの記録は残さない（同じ封筒を二重に持たない）。
    const check = await openDB(DB_NAME, 3);
    await expect(check.get('vault', 'vault' as never)).resolves.toBeUndefined();
    await expect(check.get('secrets', 'token' as never)).resolves.toBeUndefined();
    check.close();
  });
});
