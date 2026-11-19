/**
 * ボルトの状態。平文の秘密鍵と DEK はアンロック中のみメモリに置く。
 * 永続化するのは暗号文封筒だけ。
 */

import { create } from 'zustand';
import {
  CryptoError,
  WrongPasswordError,
  createVaultEnvelope,
  decryptVaultDataWithDek,
  generateDek,
  rewrapEnvelope,
  unlockVaultEnvelope,
  updateEnvelopeData,
} from '../../shared/crypto';
import { mergeVaultData } from '../../shared/merge';
import { MIN_PASSWORD_LENGTH } from '../../shared/types';
import type { Account, VaultData, VaultEnvelope } from '../../shared/types';
import { deriveVaultId, generateSyncToken } from '../../shared/sync';
import {
  deleteToken,
  deleteVault,
  readSettings,
  readToken,
  readVault,
  updateSyncedRevision,
  writeSettings,
  writeToken,
  writeVault,
} from './storage';
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from './settings';
import { SyncConflictError, SyncHttpError, SyncNotFoundError, createSyncClient } from './syncClient';

export type VaultStatus = 'loading' | 'uninitialized' | 'locked' | 'unlocked';

export type SyncState = 'local-only' | 'synced' | 'pending' | 'error' | 'conflict';

export type Conflict = {
  remoteRevision: number;
  remoteEnvelope: VaultEnvelope;
};

type VaultStore = {
  status: VaultStatus;
  accounts: Account[];
  envelope: VaultEnvelope | null;
  settings: Settings;
  token: string | null;
  vaultId: string | null;
  syncState: SyncState;
  syncError: string | null;
  lastSyncedAt: string | null;
  conflict: Conflict | null;
  failedAttempts: number;
  cooldownUntil: number;
  /** 作成直後に一度だけ表示する同期コード（確認後に null へ） */
  pendingSyncToken: string | null;
  /** アンロック中の DEK（メモリのみ、ロック時に null） */
  dek: Uint8Array | null;

  initialize: () => Promise<void>;
  acknowledgeSyncToken: () => void;
  flushSync: () => void;
  createVault: (password: string, options: { sync: boolean }) => Promise<string | null>;
  unlock: (password: string) => Promise<{ ok: boolean; cooldownSeconds?: number }>;
  lock: () => void;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  saveAccounts: (accounts: Account[]) => Promise<void>;
  upsertAccount: (account: Account) => Promise<void>;
  removeAccount: (id: string) => Promise<void>;
  reorderAccounts: (orderedIds: string[]) => Promise<void>;
  replaceVault: (envelope: VaultEnvelope, token: string | null) => Promise<void>;
  attachSync: (token: string) => Promise<void>;
  disableSync: () => Promise<void>;
  changePassword: (current: string, next: string) => Promise<boolean>;
  syncNow: () => Promise<void>;
  refreshRemote: () => Promise<void>;
  resolveConflict: (mode: 'overwrite' | 'discard' | 'merge') => Promise<{ added: number; updated: number }>;
  importEnvelope: (envelope: VaultEnvelope, mode: 'replace' | 'merge') => Promise<number>;
  wipe: () => Promise<void>;
};

export const syncClient = createSyncClient();

const SYNC_DEBOUNCE_MS = 2000;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

export function makeAccountId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function sortAccounts(accounts: readonly Account[]): Account[] {
  return [...accounts].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function parseVaultData(plaintext: string): VaultData {
  const parsed = JSON.parse(plaintext) as Partial<VaultData>;
  return { accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [] };
}

function nextOrder(accounts: readonly Account[]): number {
  return accounts.reduce((max, account) => Math.max(max, account.order), -1) + 1;
}

export const useVaultStore = create<VaultStore>((set, get) => {
  function scheduleSync(): void {
    if (syncTimer !== null) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      void get().syncNow();
    }, SYNC_DEBOUNCE_MS);
  }

  /** 保留中の同期を即座に実行する（ページ離脱時など）。 */
  function flushSync(): void {
    if (syncTimer === null) return;
    clearTimeout(syncTimer);
    syncTimer = null;
    void get().syncNow();
  }

  /** 現在のアカウントを新しい revision で暗号化して永続化する。 */
  async function persist(accounts: Account[]): Promise<void> {
    const { dek, envelope, token } = get();
    if (dek === null || envelope === null) return;
    const revision = envelope.revision + 1;
    const next = await updateEnvelopeData(
      envelope,
      dek,
      JSON.stringify({ accounts: sortAccounts(accounts) }),
      revision,
      new Date().toISOString(),
    );
    await writeVault(next, token === null ? null : envelope.revision);
    set({
      envelope: next,
      accounts: sortAccounts(accounts),
      syncState: token === null ? 'local-only' : 'pending',
    });
    if (token !== null) scheduleSync();
  }

  /** サーバーに新しい版があれば競合として提示する（黙って上書きしない）。 */
  async function refreshRemote(): Promise<void> {
    const { token, vaultId, envelope } = get();
    if (token === null || vaultId === null || envelope === null) return;
    try {
      const remote = await syncClient.get(vaultId, token);
      if (remote.revision > envelope.revision) {
        set({
          conflict: { remoteRevision: remote.revision, remoteEnvelope: remote.envelope },
          syncState: 'conflict',
        });
      } else if (remote.revision === envelope.revision) {
        set({ syncState: 'synced', lastSyncedAt: remote.envelope.updatedAt });
      }
    } catch (error) {
      if (error instanceof SyncNotFoundError) {
        // サーバーに無い → 初回アップロード待ち。
        set({ syncState: 'pending' });
      }
    }
  }

  return {
    status: 'loading',
    accounts: [],
    envelope: null,
    settings: { ...DEFAULT_SETTINGS },
    token: null,
    vaultId: null,
    syncState: 'local-only',
    syncError: null,
    lastSyncedAt: null,
    conflict: null,
    failedAttempts: 0,
    cooldownUntil: 0,
    pendingSyncToken: null,
    dek: null,

    acknowledgeSyncToken() {
      set({ pendingSyncToken: null });
    },

    flushSync,

    async initialize() {
      const [stored, token, settings] = await Promise.all([
        readVault(),
        readToken(),
        readSettings<unknown>(),
      ]);
      const normalized = normalizeSettings(settings);
      if (stored === null) {
        set({ status: 'uninitialized', settings: normalized, token, vaultId: null });
        return;
      }
      set({
        status: 'locked',
        envelope: stored.envelope,
        settings: normalized,
        token,
        vaultId: token === null ? null : await deriveVaultId(token),
        syncState: token === null ? 'local-only' : 'synced',
        lastSyncedAt: token === null ? null : stored.savedAt,
      });
    },

    async createVault(password, options) {
      if (password.length < MIN_PASSWORD_LENGTH) throw new Error('password_too_short');
      const token = options.sync ? generateSyncToken() : null;
      const dek = await generateDek();
      const envelope = await createVaultEnvelope({
        password,
        dek,
        plaintext: JSON.stringify({ accounts: [] }),
        revision: 1,
      });
      const vaultId = token === null ? null : await deriveVaultId(token);
      await writeVault(envelope, token === null ? null : 0);
      if (token !== null) await writeToken(token);
      set({
        status: 'unlocked',
        envelope,
        accounts: [],
        dek,
        token,
        vaultId,
        syncState: token === null ? 'local-only' : 'pending',
        failedAttempts: 0,
        cooldownUntil: 0,
        conflict: null,
        syncError: null,
        pendingSyncToken: token,
      });
      // 初回アップロードは即時に行う（別端末がすぐ接続できるようにする）。
      if (token !== null) void get().syncNow();
      return token;
    },

    async unlock(password) {
      const { envelope, cooldownUntil } = get();
      if (envelope === null) return { ok: false };
      const now = Date.now();
      if (cooldownUntil > now) {
        return { ok: false, cooldownSeconds: Math.ceil((cooldownUntil - now) / 1000) };
      }
      try {
        const unlocked = await unlockVaultEnvelope(envelope, password);
        set({
          status: 'unlocked',
          dek: unlocked.dek,
          accounts: sortAccounts(parseVaultData(unlocked.plaintext).accounts),
          failedAttempts: 0,
          cooldownUntil: 0,
        });
        void refreshRemote();
        return { ok: true };
      } catch (error) {
        if (!(error instanceof WrongPasswordError)) throw error;
        const attempts = get().failedAttempts + 1;
        if (attempts >= 5) {
          set({ failedAttempts: 0, cooldownUntil: now + 30_000 });
          return { ok: false, cooldownSeconds: 30 };
        }
        set({ failedAttempts: attempts });
        return { ok: false };
      }
    },

    lock() {
      if (syncTimer !== null) {
        clearTimeout(syncTimer);
        syncTimer = null;
      }
      set({ status: 'locked', dek: null, accounts: [], conflict: null });
    },

    async updateSettings(patch) {
      const settings = { ...get().settings, ...patch };
      set({ settings });
      await writeSettings(settings);
    },

    async saveAccounts(accounts) {
      await persist(accounts);
    },

    async upsertAccount(account) {
      const accounts = get().accounts;
      const exists = accounts.some((a) => a.id === account.id);
      const next = exists
        ? accounts.map((a) => (a.id === account.id ? account : a))
        : [...accounts, { ...account, order: nextOrder(accounts) }];
      await persist(next);
    },

    async removeAccount(id) {
      await persist(get().accounts.filter((a) => a.id !== id));
    },

    async reorderAccounts(orderedIds) {
      const position = new Map(orderedIds.map((id, index) => [id, index]));
      const now = new Date().toISOString();
      const next = get().accounts.map((account) => {
        const order = position.get(account.id);
        if (order === undefined || order === account.order) return account;
        return { ...account, order, updatedAt: now };
      });
      await persist(next);
    },

    async replaceVault(envelope, token) {
      await writeVault(envelope, token === null ? null : 0);
      if (token === null) await deleteToken();
      else await writeToken(token);
      set({
        status: 'locked',
        envelope,
        dek: null,
        accounts: [],
        token,
        vaultId: token === null ? null : await deriveVaultId(token),
        syncState: token === null ? 'local-only' : 'synced',
        conflict: null,
        syncError: null,
      });
    },

    async attachSync(token) {
      const vaultId = await deriveVaultId(token);
      const remote = await syncClient.get(vaultId, token);
      await writeVault(remote.envelope, remote.revision);
      await writeToken(token);
      set({
        status: 'locked',
        envelope: remote.envelope,
        dek: null,
        accounts: [],
        token,
        vaultId,
        syncState: 'synced',
        lastSyncedAt: remote.envelope.updatedAt,
        conflict: null,
        syncError: null,
      });
    },

    async disableSync() {
      const { vaultId, token, envelope } = get();
      if (vaultId !== null && token !== null) {
        try {
          await syncClient.remove(vaultId, token);
        } catch {
          // オフラインでもローカル側の同期設定は外す。
        }
      }
      await deleteToken();
      if (envelope !== null) await writeVault(envelope, null);
      set({ token: null, vaultId: null, syncState: 'local-only', syncError: null, lastSyncedAt: null });
    },

    async changePassword(current, next) {
      const { envelope, dek, token } = get();
      if (envelope === null || dek === null) return false;
      try {
        await unlockVaultEnvelope(envelope, current);
      } catch {
        return false;
      }
      const rewrapped = await rewrapEnvelope(envelope, dek, next);
      await writeVault(rewrapped, token === null ? null : envelope.revision);
      set({ envelope: rewrapped });
      if (token !== null) scheduleSync();
      return true;
    },

    async syncNow() {
      const { token, vaultId, envelope } = get();
      if (token === null || vaultId === null || envelope === null) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        set({ syncState: 'pending', syncError: 'offline' });
        return;
      }
      try {
        // envelope.revision が「書き込み後の revision」、基準はその 1 つ前。
        await syncClient.put(vaultId, token, envelope, Math.max(0, envelope.revision - 1));
        await updateSyncedRevision(envelope.revision);
        set({ syncState: 'synced', syncError: null, lastSyncedAt: new Date().toISOString() });
      } catch (error) {
        if (error instanceof SyncConflictError) {
          try {
            const remote = await syncClient.get(vaultId, token);
            set({
              syncState: 'conflict',
              conflict: { remoteRevision: remote.revision, remoteEnvelope: remote.envelope },
            });
          } catch {
            set({ syncState: 'error', syncError: 'conflict_fetch_failed' });
          }
          return;
        }
        if (error instanceof SyncNotFoundError) {
          try {
            await syncClient.put(vaultId, token, envelope, 0);
            set({ syncState: 'synced', syncError: null, lastSyncedAt: new Date().toISOString() });
          } catch {
            set({ syncState: 'error', syncError: 'put_failed' });
          }
          return;
        }
        set({
          syncState: 'error',
          syncError: error instanceof SyncHttpError ? `http_${error.status}` : 'network',
        });
      }
    },

    async refreshRemote() {
      await refreshRemote();
    },

    async resolveConflict(mode) {
      const { conflict, token, vaultId, envelope, dek } = get();
      if (conflict === null || token === null || vaultId === null) return { added: 0, updated: 0 };

      if (mode === 'discard') {
        await writeVault(conflict.remoteEnvelope, conflict.remoteRevision);
        set({ envelope: conflict.remoteEnvelope, conflict: null, syncState: 'synced' });
        if (dek !== null) {
          try {
            const plaintext = await decryptVaultDataWithDek(conflict.remoteEnvelope, dek);
            set({ accounts: sortAccounts(parseVaultData(plaintext).accounts) });
          } catch {
            set({ status: 'locked', dek: null, accounts: [] });
          }
        }
        return { added: 0, updated: 0 };
      }

      if (envelope === null || dek === null) return { added: 0, updated: 0 };

      let accounts = get().accounts;
      let added = 0;
      let updated = 0;
      if (mode === 'merge') {
        try {
          const plaintext = await decryptVaultDataWithDek(conflict.remoteEnvelope, dek);
          const merged = mergeVaultData({ accounts }, parseVaultData(plaintext));
          accounts = merged.data.accounts;
          added = merged.added;
          updated = merged.updated;
        } catch (error) {
          if (error instanceof CryptoError) {
            set({ conflict: null, status: 'locked', dek: null, accounts: [] });
            return { added: 0, updated: 0 };
          }
          throw error;
        }
      }

      const revision = conflict.remoteRevision + 1;
      const next = await updateEnvelopeData(
        envelope,
        dek,
        JSON.stringify({ accounts: sortAccounts(accounts) }),
        revision,
        new Date().toISOString(),
      );
      await writeVault(next, conflict.remoteRevision);
      set({
        envelope: next,
        accounts: sortAccounts(accounts),
        conflict: null,
        syncState: 'pending',
      });
      await get().syncNow();
      return { added, updated };
    },

    async importEnvelope(envelope, mode) {
      const { dek, envelope: current } = get();
      if (mode === 'replace' || dek === null || current === null) {
        await writeVault(envelope, get().token === null ? null : 0);
        set({ envelope, status: 'locked', dek: null, accounts: [] });
        return 0;
      }
      // 同じ DEK で復号できる場合のみマージできる。
      const plaintext = await decryptVaultDataWithDek(envelope, dek);
      const merged = mergeVaultData({ accounts: get().accounts }, parseVaultData(plaintext));
      await persist(merged.data.accounts);
      return merged.added + merged.updated;
    },

    async wipe() {
      await deleteVault();
      set({
        status: 'uninitialized',
        accounts: [],
        envelope: null,
        dek: null,
        token: null,
        vaultId: null,
        syncState: 'local-only',
        syncError: null,
        lastSyncedAt: null,
        conflict: null,
        failedAttempts: 0,
        cooldownUntil: 0,
      });
    },
  };
});
