/**
 * ボルトの状態。平文の秘密鍵と DEK はアンロック中のみメモリに置く。
 * 永続化するのは暗号文封筒だけ。
 *
 * 書き込みは 1 本のキューで直列化する（同時保存で先の変更が失われないように）。
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

/** アンロック中でないと実行できない操作。 */
export class VaultLockedError extends Error {
  constructor() {
    super('vault_locked');
    this.name = 'VaultLockedError';
  }
}

/** 操作中に別のボルトへ置き換わった（画面離脱後の完了など）。 */
export class VaultChangedError extends Error {
  constructor() {
    super('vault_changed');
    this.name = 'VaultChangedError';
  }
}

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
  /** サーバーと一致している revision（ローカル専用モードでは null） */
  syncedRevision: number | null;
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
  resolveConflict: (
    mode: 'overwrite' | 'discard' | 'merge',
  ) => Promise<{ added: number; updated: number; resolved: boolean }>;
  importEnvelope: (envelope: VaultEnvelope, mode: 'replace' | 'merge', password?: string) => Promise<number>;
  wipe: () => Promise<void>;
};

export const syncClient = createSyncClient();

const SYNC_DEBOUNCE_MS = 2000;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

/** 保存処理の直列化キュー。後から始まった保存が先の変更を取りこぼさない。 */
let writeQueue: Promise<unknown> = Promise.resolve();

function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(task, task);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

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

  /** 保留中の同期を即座に実行する（ページ離脱・ロック時など）。 */
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
    await writeVault(next, get().syncedRevision);
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
        set({ syncState: 'synced', syncedRevision: remote.revision, lastSyncedAt: remote.envelope.updatedAt });
      } else {
        // サーバーが古い（未送信の変更がある）→ 送信待ちとして扱う。
        set({ syncState: 'pending' });
        scheduleSync();
      }
    } catch (error) {
      if (error instanceof SyncNotFoundError) {
        // サーバーに無い → 初回アップロード待ち。
        set({ syncState: 'pending', syncedRevision: null });
        scheduleSync();
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
    syncedRevision: null,
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
      const syncedRevision = stored.syncedRevision;
      const pending =
        token !== null && (syncedRevision === null || syncedRevision !== stored.envelope.revision);
      set({
        status: 'locked',
        envelope: stored.envelope,
        settings: normalized,
        token,
        vaultId: token === null ? null : await deriveVaultId(token),
        syncedRevision: token === null ? null : syncedRevision,
        syncState: token === null ? 'local-only' : pending ? 'pending' : 'synced',
        lastSyncedAt: token === null ? null : stored.savedAt,
      });
      // 未同期の変更が残っている場合は、ロック画面のままでも送信を試みる。
      if (pending) scheduleSync();
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
        syncedRevision: token === null ? null : 0,
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
      // 2 秒デバウンス内の変更を取りこぼさない（syncNow は DEK を必要としない）。
      flushSync();
      set({ status: 'locked', dek: null, accounts: [], conflict: null });
    },

    async updateSettings(patch) {
      const settings = { ...get().settings, ...patch };
      set({ settings });
      await writeSettings(settings);
    },

    async saveAccounts(accounts) {
      await runExclusive(() => persist(accounts));
    },

    async upsertAccount(account) {
      await runExclusive(async () => {
        const accounts = get().accounts;
        const exists = accounts.some((a) => a.id === account.id);
        const next = exists
          ? accounts.map((a) => (a.id === account.id ? account : a))
          : [...accounts, { ...account, order: nextOrder(accounts) }];
        await persist(next);
      });
    },

    async removeAccount(id) {
      await runExclusive(async () => {
        await persist(get().accounts.filter((a) => a.id !== id));
      });
    },

    async reorderAccounts(orderedIds) {
      await runExclusive(async () => {
        const position = new Map(orderedIds.map((id, index) => [id, index]));
        const now = new Date().toISOString();
        const next = get().accounts.map((account) => {
          const order = position.get(account.id);
          if (order === undefined || order === account.order) return account;
          return { ...account, order, updatedAt: now };
        });
        await persist(next);
      });
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
        syncedRevision: token === null ? null : 0,
        syncState: token === null ? 'local-only' : 'synced',
        conflict: null,
        syncError: null,
      });
    },

    async attachSync(token) {
      // 取得中に別のボルトが作られた場合は、そのボルトを上書きしない。
      const before = get().envelope;
      const vaultId = await deriveVaultId(token);
      const remote = await syncClient.get(vaultId, token);
      if (get().envelope !== before) throw new VaultChangedError();
      await writeVault(remote.envelope, remote.revision);
      await writeToken(token);
      set({
        status: 'locked',
        envelope: remote.envelope,
        dek: null,
        accounts: [],
        token,
        vaultId,
        syncedRevision: remote.revision,
        syncState: 'synced',
        lastSyncedAt: remote.envelope.updatedAt,
        conflict: null,
        syncError: null,
      });
    },

    async disableSync() {
      const { vaultId, token } = get();
      if (vaultId !== null && token !== null) {
        try {
          await syncClient.remove(vaultId, token);
        } catch {
          // オフラインでもローカル側の同期設定は外す。
        }
      }
      await deleteToken();
      // await の間に persist が走っていても、最新の envelope / syncedRevision を保存する。
      const latest = get().envelope;
      if (latest !== null) await writeVault(latest, null);
      set({
        token: null,
        vaultId: null,
        syncedRevision: null,
        syncState: 'local-only',
        syncError: null,
        lastSyncedAt: null,
      });
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
      // データ部は revision を AAD に含むため、revision を進めるなら同時に再暗号化する。
      const updated = await updateEnvelopeData(
        rewrapped,
        dek,
        JSON.stringify({ accounts: sortAccounts(get().accounts) }),
        envelope.revision + 1,
        new Date().toISOString(),
      );
      await writeVault(updated, get().syncedRevision);
      set({ envelope: updated, syncState: token === null ? 'local-only' : 'pending' });
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
      // 基準は「最後にサーバーと一致した revision」（envelope.revision - 1 ではない）。
      const sent = envelope;
      const base = get().syncedRevision ?? 0;
      try {
        await syncClient.put(vaultId, token, sent, base);
        await updateSyncedRevision(sent.revision);
        set({ syncedRevision: sent.revision });
        const latest = get().envelope;
        if (latest !== null && latest.revision > sent.revision) {
          // 送信中にさらに編集された → 続けて送る。
          set({ syncState: 'pending', syncError: null });
          scheduleSync();
        } else {
          set({ syncState: 'synced', syncError: null, lastSyncedAt: new Date().toISOString() });
        }
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
            await syncClient.put(vaultId, token, sent, 0);
            await updateSyncedRevision(sent.revision);
            set({
              syncedRevision: sent.revision,
              syncState: 'synced',
              syncError: null,
              lastSyncedAt: new Date().toISOString(),
            });
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
      if (conflict === null || token === null || vaultId === null) {
        return { added: 0, updated: 0, resolved: false };
      }

      if (mode === 'discard') {
        await writeVault(conflict.remoteEnvelope, conflict.remoteRevision);
        set({
          envelope: conflict.remoteEnvelope,
          conflict: null,
          syncState: 'synced',
          syncedRevision: conflict.remoteRevision,
        });
        if (dek !== null) {
          try {
            const plaintext = await decryptVaultDataWithDek(conflict.remoteEnvelope, dek);
            set({ accounts: sortAccounts(parseVaultData(plaintext).accounts) });
          } catch {
            set({ status: 'locked', dek: null, accounts: [] });
          }
        }
        return { added: 0, updated: 0, resolved: true };
      }

      if (envelope === null || dek === null) return { added: 0, updated: 0, resolved: false };

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
            return { added: 0, updated: 0, resolved: false };
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
        syncedRevision: conflict.remoteRevision,
        syncState: 'pending',
      });
      await get().syncNow();
      return { added, updated, resolved: true };
    },

    /**
     * バックアップ封筒を取り込む。
     * - replace: 封筒をそのまま差し替える（別ボルトのバックアップも可）。
     * - merge: バックアップ自身のパスワードで復号し、現在のボルトへ統合して現在の DEK で保存する。
     */
    async importEnvelope(envelope, mode, password) {
      if (mode === 'replace') {
        const token = get().token;
        await writeVault(envelope, token === null ? null : 0);
        set({
          envelope,
          status: 'locked',
          dek: null,
          accounts: [],
          syncedRevision: token === null ? null : 0,
          syncState: token === null ? 'local-only' : 'pending',
        });
        return 0;
      }

      const before = get();
      if (before.dek === null || before.envelope === null || before.status !== 'unlocked') {
        throw new VaultLockedError();
      }
      if (password === undefined || password === '') throw new WrongPasswordError();
      // バックアップは別のパスワード（別の DEK）で作られていてもよい。
      const unlocked = await unlockVaultEnvelope(envelope, password);
      const current = get();
      // 復号待ちの間にロックされた／ボルトが入れ替わった場合は適用しない。
      if (
        current.dek === null ||
        current.envelope !== before.envelope ||
        current.status !== 'unlocked'
      ) {
        throw new VaultLockedError();
      }
      const merged = mergeVaultData({ accounts: current.accounts }, parseVaultData(unlocked.plaintext));
      await runExclusive(() => persist(merged.data.accounts));
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
        syncedRevision: null,
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
