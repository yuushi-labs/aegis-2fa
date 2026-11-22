/**
 * IndexedDB 永続化。平文の秘密鍵は保存しない（暗号文封筒のみ）。
 *
 * v3 で複数プロファイル（1 つのブラウザ内の独立したボルト）に対応した。
 * 「vault」「secrets」「passkeys」の各ストアはプロファイル ID で区切る。
 * 設定（テーマ・言語・自動ロック）は端末共通としてそのまま共有する。
 *
 * v2 以前の単一ボルトは、v3 への移行時に既定プロファイル（id: 'main'）へ
 * そのまま引き継ぐ（封筒・同期コード・パスキーを失わない）。
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PasskeyRecord, VaultEnvelope, VaultProfile } from '../../shared/types';
import { DEFAULT_PROFILE_ID, MAX_PROFILE_NAME_LENGTH } from '../../shared/types';

/**
 * IndexedDB のデータベース名。
 *
 * **旧名のまま変えない**（`/aegis/` と `/zekey/` は同じオリジンなので、名前を変えると
 * 端末に保存済みのボルト・パスキーが新しい画面から見えなくなる）。表示名ではなく
 * 保存先の識別子なので、製品名の変更には追従させない。
 */
export const DB_NAME = 'aegis-2fa';
/** v2 でパスキー、v3 でプロファイルを追加した。 */
export const DB_VERSION = 3;

export { DEFAULT_PROFILE_ID };
export const DEFAULT_PROFILE_NAME = 'メイン';

type StoredVault = {
  /** プロファイル ID */
  id: string;
  envelope: VaultEnvelope;
  /** サーバーと一致している revision（ローカル専用モードでは null） */
  syncedRevision: number | null;
  savedAt: string;
};

type StoredToken = {
  /** プロファイル ID */
  id: string;
  /** base64url 同期トークン。ローカル完結モードでは保存しない。 */
  token: string;
};

type StoredSettings = {
  id: 'settings';
  value: unknown;
};

/** パスキーは credentialId をキーにし、所属プロファイルを添えて保存する。 */
type StoredPasskey = PasskeyRecord & { profileId?: string };

type StoredAppState = {
  id: 'active-profile';
  profileId: string;
};

interface ZekeySchema extends DBSchema {
  vault: {
    key: string;
    value: StoredVault;
  };
  secrets: {
    key: string;
    value: StoredToken;
  };
  settings: {
    key: string;
    value: StoredSettings;
  };
  passkeys: {
    key: string;
    value: StoredPasskey;
    indexes: { profileId: string };
  };
  profiles: {
    key: string;
    value: VaultProfile;
  };
  appState: {
    key: string;
    value: StoredAppState;
  };
}

let dbPromise: Promise<IDBPDatabase<ZekeySchema>> | null = null;

function getDb(): Promise<IDBPDatabase<ZekeySchema>> {
  dbPromise ??= openDB<ZekeySchema>(DB_NAME, DB_VERSION, {
    async upgrade(db, oldVersion, _newVersion, tx) {
      if (!db.objectStoreNames.contains('vault')) db.createObjectStore('vault', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('secrets')) db.createObjectStore('secrets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('passkeys')) db.createObjectStore('passkeys', { keyPath: 'id' });
      const passkeys = tx.objectStore('passkeys');
      if (!passkeys.indexNames.contains('profileId')) passkeys.createIndex('profileId', 'profileId');
      if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('appState')) db.createObjectStore('appState', { keyPath: 'id' });

      if (oldVersion > 0 && oldVersion < 3) {
        // v2 までの単一ボルトを既定プロファイルへ移す（記録は消さずに引き継ぐ）。
        const legacyVault = await tx.objectStore('vault').get('vault');
        if (legacyVault !== undefined) {
          await tx.objectStore('vault').put({
            id: DEFAULT_PROFILE_ID,
            envelope: legacyVault.envelope,
            syncedRevision: legacyVault.syncedRevision,
            savedAt: legacyVault.savedAt,
          });
          await tx.objectStore('vault').delete('vault');
        }
        const legacyToken = await tx.objectStore('secrets').get('token');
        if (legacyToken !== undefined) {
          await tx.objectStore('secrets').put({ id: DEFAULT_PROFILE_ID, token: legacyToken.token });
          await tx.objectStore('secrets').delete('token');
        }
        const legacyPasskeys = await tx.objectStore('passkeys').getAll();
        for (const record of legacyPasskeys) {
          if (record.profileId === undefined) {
            await tx.objectStore('passkeys').put({ ...record, profileId: DEFAULT_PROFILE_ID });
          }
        }
      }

      // 少なくとも 1 つのプロファイルと、選択中のプロファイルを用意する。
      const existingProfiles = await tx.objectStore('profiles').getAll();
      if (existingProfiles.length === 0) {
        await tx.objectStore('profiles').put({
          id: DEFAULT_PROFILE_ID,
          name: DEFAULT_PROFILE_NAME,
          createdAt: new Date().toISOString(),
        });
      }
      const active = await tx.objectStore('appState').get('active-profile');
      if (active === undefined) {
        await tx.objectStore('appState').put({ id: 'active-profile', profileId: DEFAULT_PROFILE_ID });
      }
    },
  });
  return dbPromise;
}

/** テスト・ログアウト用に接続を破棄する。 */
export function resetStorageCache(): void {
  dbPromise = null;
}

// --- プロファイル -----------------------------------------------------------

export async function listProfiles(): Promise<VaultProfile[]> {
  const db = await getDb();
  const profiles = await db.getAll('profiles');
  return profiles.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function readProfile(id: string): Promise<VaultProfile | null> {
  const db = await getDb();
  return (await db.get('profiles', id)) ?? null;
}

export async function putProfile(profile: VaultProfile): Promise<void> {
  const db = await getDb();
  await db.put('profiles', {
    id: profile.id,
    name: profile.name.slice(0, MAX_PROFILE_NAME_LENGTH),
    createdAt: profile.createdAt,
  });
}

export async function deleteProfileRecord(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['profiles', 'vault', 'secrets', 'passkeys'], 'readwrite');
  await tx.objectStore('profiles').delete(id);
  await tx.objectStore('vault').delete(id);
  await tx.objectStore('secrets').delete(id);
  const index = tx.objectStore('passkeys').index('profileId');
  for (const key of await index.getAllKeys(id)) {
    await tx.objectStore('passkeys').delete(key);
  }
  await tx.done;
}

export async function readActiveProfileId(): Promise<string | null> {
  const db = await getDb();
  const record = await db.get('appState', 'active-profile');
  return record?.profileId ?? null;
}

export async function writeActiveProfileId(profileId: string): Promise<void> {
  const db = await getDb();
  await db.put('appState', { id: 'active-profile', profileId });
}

// --- ボルト（プロファイルごと） ---------------------------------------------

export async function readVault(profileId: string = DEFAULT_PROFILE_ID): Promise<StoredVault | null> {
  const db = await getDb();
  return (await db.get('vault', profileId)) ?? null;
}

export async function writeVault(
  profileId: string,
  envelope: VaultEnvelope,
  syncedRevision: number | null,
): Promise<void> {
  const db = await getDb();
  await db.put('vault', {
    id: profileId,
    envelope,
    syncedRevision,
    savedAt: new Date().toISOString(),
  });
}

export async function updateSyncedRevision(
  profileId: string,
  revision: number | null,
): Promise<void> {
  const db = await getDb();
  // 読み取りと書き込みを 1 つのトランザクションにまとめる（並行する writeVault を上書きしない）。
  const tx = db.transaction('vault', 'readwrite');
  const existing = await tx.store.get(profileId);
  if (existing !== undefined) {
    await tx.store.put({ ...existing, syncedRevision: revision });
  }
  await tx.done;
}

export async function deleteVault(profileId: string = DEFAULT_PROFILE_ID): Promise<void> {
  const db = await getDb();
  // パスキーの登録はボルトに属するので、ボルトごと消す。
  const tx = db.transaction(['vault', 'secrets', 'passkeys'], 'readwrite');
  await tx.objectStore('vault').delete(profileId);
  await tx.objectStore('secrets').delete(profileId);
  const index = tx.objectStore('passkeys').index('profileId');
  for (const key of await index.getAllKeys(profileId)) {
    await tx.objectStore('passkeys').delete(key);
  }
  await tx.done;
}

// --- パスキー ---------------------------------------------------------------

export async function readPasskeys(profileId: string = DEFAULT_PROFILE_ID): Promise<PasskeyRecord[]> {
  const db = await getDb();
  return await db.getAllFromIndex('passkeys', 'profileId', profileId);
}

export async function putPasskey(
  profileId: string,
  record: PasskeyRecord,
): Promise<void> {
  const db = await getDb();
  await db.put('passkeys', { ...record, profileId });
}

export async function deletePasskey(id: string, profileId: string = DEFAULT_PROFILE_ID): Promise<void> {
  const db = await getDb();
  const existing = await db.get('passkeys', id);
  // 別プロファイルの登録を、たまたま同じ id というだけで消さない。
  if (existing !== undefined && existing.profileId !== undefined && existing.profileId !== profileId) {
    return;
  }
  await db.delete('passkeys', id);
}

/** 保存済みのパスキー登録を丸ごと置き換える（ボルト切り替え時の棚卸しに使う）。 */
export async function replacePasskeys(
  profileId: string,
  records: readonly PasskeyRecord[],
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('passkeys', 'readwrite');
  const index = tx.store.index('profileId');
  for (const key of await index.getAllKeys(profileId)) {
    await tx.store.delete(key);
  }
  for (const record of records) await tx.store.put({ ...record, profileId });
  await tx.done;
}

export async function deleteAllPasskeys(profileId: string = DEFAULT_PROFILE_ID): Promise<void> {
  await replacePasskeys(profileId, []);
}

// --- 同期コード -------------------------------------------------------------

export async function readToken(profileId: string = DEFAULT_PROFILE_ID): Promise<string | null> {
  const db = await getDb();
  return (await db.get('secrets', profileId))?.token ?? null;
}

export async function writeToken(profileId: string, token: string): Promise<void> {
  const db = await getDb();
  await db.put('secrets', { id: profileId, token });
}

export async function deleteToken(profileId: string = DEFAULT_PROFILE_ID): Promise<void> {
  const db = await getDb();
  await db.delete('secrets', profileId);
}

// --- 設定（端末共通） -------------------------------------------------------

export async function readSettings<T>(): Promise<T | null> {
  const db = await getDb();
  return ((await db.get('settings', 'settings'))?.value as T | undefined) ?? null;
}

export async function writeSettings(value: unknown): Promise<void> {
  const db = await getDb();
  await db.put('settings', { id: 'settings', value });
}
