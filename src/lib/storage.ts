/**
 * IndexedDB 永続化。平文の秘密鍵は保存しない（暗号文封筒のみ）。
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { VaultEnvelope } from '../../shared/types';

export const DB_NAME = 'aegis-2fa';
export const DB_VERSION = 1;

type StoredVault = {
  id: 'vault';
  envelope: VaultEnvelope;
  /** サーバーと一致している revision（ローカル専用モードでは null） */
  syncedRevision: number | null;
  savedAt: string;
};

type StoredToken = {
  id: 'token';
  /** base64url 同期トークン。ローカル完結モードでは保存しない。 */
  token: string;
};

type StoredSettings = {
  id: 'settings';
  value: unknown;
};

interface AegisSchema extends DBSchema {
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
}

let dbPromise: Promise<IDBPDatabase<AegisSchema>> | null = null;

function getDb(): Promise<IDBPDatabase<AegisSchema>> {
  dbPromise ??= openDB<AegisSchema>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('vault')) db.createObjectStore('vault', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('secrets')) db.createObjectStore('secrets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' });
    },
  });
  return dbPromise;
}

/** テスト・ログアウト用に接続を破棄する。 */
export function resetStorageCache(): void {
  dbPromise = null;
}

export async function readVault(): Promise<StoredVault | null> {
  const db = await getDb();
  return (await db.get('vault', 'vault')) ?? null;
}

export async function writeVault(envelope: VaultEnvelope, syncedRevision: number | null): Promise<void> {
  const db = await getDb();
  await db.put('vault', {
    id: 'vault',
    envelope,
    syncedRevision,
    savedAt: new Date().toISOString(),
  });
}

export async function updateSyncedRevision(revision: number | null): Promise<void> {
  const db = await getDb();
  // 読み取りと書き込みを 1 つのトランザクションにまとめる（並行する writeVault を上書きしない）。
  const tx = db.transaction('vault', 'readwrite');
  const existing = await tx.store.get('vault');
  if (existing !== undefined) {
    await tx.store.put({ ...existing, syncedRevision: revision });
  }
  await tx.done;
}

export async function deleteVault(): Promise<void> {
  const db = await getDb();
  await db.delete('vault', 'vault');
  await db.delete('secrets', 'token');
}

export async function readToken(): Promise<string | null> {
  const db = await getDb();
  return (await db.get('secrets', 'token'))?.token ?? null;
}

export async function writeToken(token: string): Promise<void> {
  const db = await getDb();
  await db.put('secrets', { id: 'token', token });
}

export async function deleteToken(): Promise<void> {
  const db = await getDb();
  await db.delete('secrets', 'token');
}

export async function readSettings<T>(): Promise<T | null> {
  const db = await getDb();
  return ((await db.get('settings', 'settings'))?.value as T | undefined) ?? null;
}

export async function writeSettings(value: unknown): Promise<void> {
  const db = await getDb();
  await db.put('settings', { id: 'settings', value });
}
