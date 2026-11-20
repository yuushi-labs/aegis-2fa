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
import { mergeTombstones, mergeVaultData } from '../../shared/merge';
import {
  PasskeyPrfUnsupportedError,
  PasskeyCancelledError,
  PasskeyUnavailableError,
  createPasskeyCredential,
  getPasskeyAssertion,
  isPasskeyAvailable,
} from './passkeys';
import {
  bindPasskeysToFingerprint,
  derivePasskeyKek,
  generatePrfSalt,
  passkeyUserId,
  unwrapDekForPasskey,
  validPasskeysForEnvelope,
  wrapDekForPasskey,
} from '../../shared/passkey';
import { base64ToBytes, bytesToBase64 } from '../../shared/encoding';
import { MIN_PASSWORD_LENGTH } from '../../shared/types';
import type { Account, PasskeyRecord, Tombstone, VaultData, VaultEnvelope } from '../../shared/types';
import { deriveVaultId, generateSyncToken } from '../../shared/sync';
import {
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
  updateSyncedRevision,
  writeSettings,
  writeToken,
  writeVault,
} from './storage';
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from './settings';
import { clearSessionDek, envelopeFingerprint, readSessionDek, saveSessionDek } from './sessionKey';
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

/** パスキー登録の結果（画面でメッセージを出し分ける）。 */
export type PasskeyRegisterResult =
  | { ok: true; record: PasskeyRecord }
  | { ok: false; reason: 'cancelled' | 'prf_unsupported' | 'unavailable' | 'failed' };

/** パスキー解除の結果。 */
export type PasskeyUnlockResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'cancelled' | 'prf_unsupported' | 'unavailable' | 'mismatch' | 'no_passkeys' | 'failed';
    };

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
  /** 削除記録（同期マージで削除済みアカウントを復活させない） */
  tombstones: Tombstone[];
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
  /** このボルトで使えるパスキー / セキュリティキーの登録（端末内のみ） */
  passkeys: PasskeyRecord[];

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
  registerPasskey: (name: string) => Promise<PasskeyRegisterResult>;
  removePasskey: (id: string) => Promise<void>;
  unlockWithPasskey: () => Promise<PasskeyUnlockResult>;
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

/** 同期送信の直列化チェーン（待機中の呼び出しも含めて順に実行する）。 */
let syncChain: Promise<void> = Promise.resolve();

/**
 * ボルトの世代。作成・置換・接続・削除で進む。
 * 待機中に別のライフサイクル操作が完了したら、古い保存を確定しないために使う。
 */
let lifecycleGeneration = 0;

/**
 * アンロック中のセッション。アンロック・ロック・削除・置換・接続で進む。
 * 待機中にロックされたら、平文（アカウント）をストアへ戻さないために使う。
 */
let unlockSession = 0;

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
  const tombstones = Array.isArray(parsed.tombstones)
    ? parsed.tombstones.filter(
        (item): item is Tombstone =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Tombstone).id === 'string' &&
          typeof (item as Tombstone).deletedAt === 'string',
      )
    : [];
  return { accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [], tombstones };
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
  async function persist(accounts: Account[], tombstones: Tombstone[] = get().tombstones): Promise<void> {
    const { dek, envelope, token } = get();
    if (dek === null || envelope === null) return;
    const generation = lifecycleGeneration;
    const session = unlockSession;
    const revision = envelope.revision + 1;
    const next = await updateEnvelopeData(
      envelope,
      dek,
      JSON.stringify({ accounts: sortAccounts(accounts), tombstones }),
      revision,
      new Date().toISOString(),
    );
    // 暗号化の待機中に削除・置換されていたら保存しない（削除したボルトを復元しない）。
    if (generation !== lifecycleGeneration || get().envelope !== envelope) return;
    await writeVault(next, get().syncedRevision);
    // 同じボルトへの保存は有効。ただし待機中にロックされたら平文は戻さない。
    if (session !== unlockSession || get().dek === null) {
      set({ envelope: next, syncState: token === null ? 'local-only' : 'pending' });
    } else {
      set({
        envelope: next,
        accounts: sortAccounts(accounts),
        tombstones,
        syncState: token === null ? 'local-only' : 'pending',
      });
    }
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
        // 同じ revision でも封筒が違えば、別端末が同じ revision から編集している。
        const sameEnvelope =
          remote.envelope.data.iv === envelope.data.iv &&
          remote.envelope.data.ciphertext === envelope.data.ciphertext;
        if (sameEnvelope) {
          set({ syncState: 'synced', syncedRevision: remote.revision, lastSyncedAt: remote.envelope.updatedAt });
        } else {
          set({
            conflict: { remoteRevision: remote.revision, remoteEnvelope: remote.envelope },
            syncState: 'conflict',
          });
        }
      } else {
        // サーバーが古い（未送信の変更がある）→ 送信待ちとして扱う。
        // ここで基準 revision を remote に合わせると、サーバー側の別の編集を
        // 競合として検出できなくなるため、最後に一致した revision のまま送る。
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

  /**
   * 保存済みのパスキー登録を今の封筒に合わせて棚卸しする。
   *
   * - DEK が変わった（別ボルトの取り込み・別端末の同期コード）登録は削除する。
   *   残すと「解除できるはずなのに失敗する」ボタンになるため。
   * - 同じ DEK で封筒だけ変わった（パスワード変更）登録は、保存している指紋を
   *   今の封筒へ付け替えて使い続けられるようにする。
   */
  async function syncPasskeys(envelope: VaultEnvelope | null): Promise<PasskeyRecord[]> {
    if (envelope === null) {
      await deleteAllPasskeys();
      set({ passkeys: [] });
      return [];
    }
    const stored = await readPasskeys();
    const valid = validPasskeysForEnvelope(stored, envelope);
    const rebound = bindPasskeysToFingerprint(valid, envelopeFingerprint(envelope));
    const unchanged =
      stored.length === valid.length && rebound.every((record, index) => record === valid[index]);
    if (!unchanged) await replacePasskeys(rebound);
    set({ passkeys: rebound });
    return rebound;
  }

  /** 実際の送信処理（syncNow は 1 本ずつ直列化して呼ぶ）。 */
  async function runSync(): Promise<void> {
    const { token, vaultId, envelope } = get();
    if (token === null || vaultId === null || envelope === null) return;
    // 待機中にボルトが置き換わった／消えたら、状態も保存先も触らない。
    const generation = lifecycleGeneration;
    const isCurrent = (): boolean => generation === lifecycleGeneration && get().vaultId === vaultId;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      set({ syncState: 'pending', syncError: 'offline' });
      return;
    }
    // 基準は「最後にサーバーと一致した revision」（envelope.revision - 1 ではない）。
    const sent = envelope;
    const base = get().syncedRevision ?? 0;
    try {
      await syncClient.put(vaultId, token, sent, base);
      if (!isCurrent()) return;
      await updateSyncedRevision(sent.revision);
      if (!isCurrent()) return;
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
          if (!isCurrent()) return;
          // 応答だけ失われた PUT を「競合」と誤認しない（サーバーが同じ封筒を持っている）。
          const sameEnvelope =
            remote.revision === sent.revision &&
            remote.envelope.data.iv === sent.data.iv &&
            remote.envelope.data.ciphertext === sent.data.ciphertext;
          if (sameEnvelope) {
            await updateSyncedRevision(remote.revision);
            if (!isCurrent()) return;
            set({ syncedRevision: remote.revision, syncState: 'synced', syncError: null });
            return;
          }
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
          if (!isCurrent()) return;
          await updateSyncedRevision(sent.revision);
          if (!isCurrent()) return;
          set({ syncedRevision: sent.revision, syncError: null });
          const latest = get().envelope;
          if (latest !== null && latest.revision > sent.revision) {
            // 再作成の送信中にさらに編集された → 続けて送る。
            set({ syncState: 'pending' });
            scheduleSync();
          } else {
            set({ syncState: 'synced', lastSyncedAt: new Date().toISOString() });
          }
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
  }

  return {
    status: 'loading',
    accounts: [],
    tombstones: [],
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
    passkeys: [],

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
        clearSessionDek();
        // ボルトが無いなら、パスキーの登録も残さない。
        await syncPasskeys(null);
        set({ status: 'uninitialized', settings: normalized, token, vaultId: null });
        return;
      }
      const syncedRevision = stored.syncedRevision;
      // 今の封筒で使えないパスキーはここで落とす（ボルトを入れ替えた残骸を残さない）。
      await syncPasskeys(stored.envelope);
      const pending =
        token !== null && (syncedRevision === null || syncedRevision !== stored.envelope.revision);
      const base = {
        envelope: stored.envelope,
        settings: normalized,
        token,
        vaultId: token === null ? null : await deriveVaultId(token),
        syncedRevision: token === null ? null : syncedRevision,
        syncState: (token === null ? 'local-only' : pending ? 'pending' : 'synced') as SyncState,
        lastSyncedAt: token === null ? null : stored.savedAt,
      };
      // 自動ロック「なし」のときだけ、同じタブの再読み込みでアンロック状態を復帰する
      // （預けた DEK はタブを閉じる・手動ロック・設定変更で消える）。
      if (normalized.autoLockMinutes === 0) {
        const dek = readSessionDek(stored.envelope);
        if (dek !== null) {
          try {
            const data = parseVaultData(await decryptVaultDataWithDek(stored.envelope, dek));
            unlockSession += 1;
            set({
              ...base,
              status: 'unlocked',
              dek,
              accounts: sortAccounts(data.accounts),
              tombstones: data.tombstones ?? [],
            });
            void refreshRemote();
            if (pending) scheduleSync();
            return;
          } catch {
            // 復号できなければ（封筒が壊れている等）通常どおりロック画面にする。
            clearSessionDek();
          }
        }
      }
      set({ ...base, status: 'locked' });
      // 未同期の変更が残っている場合は、ロック画面のままでも送信を試みる。
      if (pending) scheduleSync();
    },

    async createVault(password, options) {
      if (password.length < MIN_PASSWORD_LENGTH) throw new Error('password_too_short');
      // 作り直したボルトに、前のボルトのセッション DEK を引き継がない。
      clearSessionDek();
      lifecycleGeneration += 1;
      const token = options.sync ? generateSyncToken() : null;
      const dek = await generateDek();
      const envelope = await createVaultEnvelope({
        password,
        dek,
        plaintext: JSON.stringify({ accounts: [], tombstones: [] }),
        revision: 1,
      });
      const vaultId = token === null ? null : await deriveVaultId(token);
      await writeVault(envelope, token === null ? null : 0);
      if (token !== null) await writeToken(token);
      // 新しいボルトに前のボルトのパスキー登録を引き継がない。
      await syncPasskeys(envelope);
      set({
        status: 'unlocked',
        envelope,
        accounts: [],
        tombstones: [],
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
      // 進行中の保存が確定してから復号する（古い封筒から accounts を復元しない）。
      return runExclusive(async () => {
        const { envelope, cooldownUntil } = get();
        if (envelope === null) return { ok: false };
        const now = Date.now();
        if (cooldownUntil > now) {
          return { ok: false, cooldownSeconds: Math.ceil((cooldownUntil - now) / 1000) };
        }
        try {
          const generation = lifecycleGeneration;
          const session = unlockSession;
          // 直前に確定した保存（IndexedDB の最新）を読み直してから復号する。
          const stored = await readVault();
          const target = stored?.envelope ?? envelope;
          if (generation !== lifecycleGeneration || session !== unlockSession) return { ok: false };
          const unlocked = await unlockVaultEnvelope(target, password);
          // 復号中に接続（attachSync）・初期化（wipe）・ロックが起きたら結果を反映しない。
          if (generation !== lifecycleGeneration || session !== unlockSession) return { ok: false };
          const data = parseVaultData(unlocked.plaintext);
          unlockSession += 1;
          // 解錠できた封筒に合わせてパスキーの登録を棚卸しする（古い封筒の残骸を出さない）。
          await syncPasskeys(target);
          set({
            status: 'unlocked',
            envelope: target,
            dek: unlocked.dek,
            accounts: sortAccounts(data.accounts),
            tombstones: data.tombstones ?? [],
            failedAttempts: 0,
            cooldownUntil: 0,
          });
          // 自動ロック「なし」なら、このタブを開いている間は再読み込みで復帰できるようにする。
          if (get().settings.autoLockMinutes === 0) saveSessionDek(target, unlocked.dek);
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
      });
    },

    /**
     * パスキー / セキュリティキーを登録し、DEK をそのパスキーで開ける形にラップして保存する。
     * 認証器とのやりとりの間は保存キューを塞がないよう、WebAuthn はキューの外で待つ。
     */
    async registerPasskey(rawName) {
      const { dek, envelope } = get();
      if (dek === null || envelope === null) throw new VaultLockedError();
      if (!isPasskeyAvailable()) return { ok: false, reason: 'unavailable' };
      const name = rawName.trim().slice(0, 64) === '' ? 'パスキー' : rawName.trim().slice(0, 64);
      // 同じボルトのパスキーは salt を共有する（1 回の get でどの認証器でも同じ KEK になる）。
      const existing = validPasskeysForEnvelope(await readPasskeys(), envelope);
      const firstRecord = existing[0];
      const prfSalt =
        firstRecord === undefined ? generatePrfSalt() : base64ToBytes(firstRecord.prfSalt);

      let created;
      try {
        created = await createPasskeyCredential({
          userId: await passkeyUserId(envelope.verifier),
          prfSalt,
          displayName: name,
        });
      } catch (error) {
        if (error instanceof PasskeyCancelledError) return { ok: false, reason: 'cancelled' };
        if (error instanceof PasskeyPrfUnsupportedError) return { ok: false, reason: 'prf_unsupported' };
        if (error instanceof PasskeyUnavailableError) return { ok: false, reason: 'unavailable' };
        return { ok: false, reason: 'failed' };
      }

      const kek = await derivePasskeyKek(created.prfOutput, prfSalt);
      return runExclusive(async () => {
        const current = get();
        if (current.dek === null || current.envelope === null) throw new VaultLockedError();
        // 認証器を待っている間にボルトが入れ替わったら、旧 DEK の登録は保存しない。
        if (current.envelope !== envelope) return { ok: false, reason: 'failed' };
        const wrappedDek = await wrapDekForPasskey(current.dek, kek);
        const record: PasskeyRecord = {
          v: 1,
          id: created.credentialId,
          name,
          createdAt: new Date().toISOString(),
          prfSalt: bytesToBase64(prfSalt),
          wrappedDek,
          vaultFingerprint: envelopeFingerprint(current.envelope),
          verifier: current.envelope.verifier,
          ...(created.transports.length === 0 ? {} : { transports: created.transports }),
        };
        await putPasskey(record);
        const stored = validPasskeysForEnvelope(await readPasskeys(), current.envelope);
        set({ passkeys: stored });
        return { ok: true, record };
      });
    },

    async removePasskey(id) {
      await deletePasskey(id);
      set({ passkeys: get().passkeys.filter((record) => record.id !== id) });
    },

    /**
     * パスキー / セキュリティキーでアンロックする。マスターパスワードを入力しない経路。
     * 認証器を待つ間に保存が走っても取りこぼさないよう、読み取りから復号までキューの中で行う。
     */
    async unlockWithPasskey() {
      return runExclusive(async (): Promise<PasskeyUnlockResult> => {
        const { envelope } = get();
        if (envelope === null) return { ok: false, reason: 'failed' };
        if (!isPasskeyAvailable()) return { ok: false, reason: 'unavailable' };
        const generation = lifecycleGeneration;
        const session = unlockSession;
        const stored = await readVault();
        const target = stored?.envelope ?? envelope;
        const candidates = validPasskeysForEnvelope(await readPasskeys(), target);
        if (candidates.length === 0) return { ok: false, reason: 'no_passkeys' };

        let assertion;
        try {
          assertion = await getPasskeyAssertion(
            candidates.map((record) => ({
              id: record.id,
              prfSalt: record.prfSalt,
              ...(record.transports === undefined ? {} : { transports: record.transports }),
            })),
          );
        } catch (error) {
          if (error instanceof PasskeyCancelledError) return { ok: false, reason: 'cancelled' };
          if (error instanceof PasskeyPrfUnsupportedError) return { ok: false, reason: 'prf_unsupported' };
          if (error instanceof PasskeyUnavailableError) return { ok: false, reason: 'unavailable' };
          return { ok: false, reason: 'failed' };
        }
        if (generation !== lifecycleGeneration || session !== unlockSession) {
          return { ok: false, reason: 'failed' };
        }

        const record = candidates.find((candidate) => candidate.id === assertion.credentialId);
        if (record === undefined) return { ok: false, reason: 'mismatch' };
        let dek: Uint8Array;
        let plaintext: string;
        try {
          const kek = await derivePasskeyKek(assertion.prfOutput, base64ToBytes(record.prfSalt));
          dek = await unwrapDekForPasskey(record.wrappedDek, kek);
          // verifier と AAD（revision）を確かめながらデータを復号する。
          plaintext = await decryptVaultDataWithDek(target, dek);
        } catch {
          return { ok: false, reason: 'mismatch' };
        }
        if (generation !== lifecycleGeneration || session !== unlockSession) {
          return { ok: false, reason: 'failed' };
        }
        const data = parseVaultData(plaintext);
        unlockSession += 1;
        set({
          status: 'unlocked',
          envelope: target,
          dek,
          accounts: sortAccounts(data.accounts),
          tombstones: data.tombstones ?? [],
          failedAttempts: 0,
          cooldownUntil: 0,
          passkeys: candidates,
        });
        // 自動ロック「なし」なら、このタブを開いている間は再読み込みで復帰できるようにする。
        if (get().settings.autoLockMinutes === 0) saveSessionDek(target, dek);
        void refreshRemote();
        return { ok: true };
      });
    },

    lock() {
      unlockSession += 1;
      // 手動ロックは、自動ロック「なし」のセッション継続も必ず打ち切る。
      clearSessionDek();
      // 2 秒デバウンス内の変更を取りこぼさない（syncNow は DEK を必要としない）。
      flushSync();
      set({ status: 'locked', dek: null, accounts: [], tombstones: [], conflict: null });
    },

    async updateSettings(patch) {
      const previous = get().settings;
      const settings = { ...previous, ...patch };
      set({ settings });
      await writeSettings(settings);
      if (settings.autoLockMinutes !== previous.autoLockMinutes) {
        // 「なし」にしたら今のセッションを引き継ぎ、それ以外に変えたら即座に打ち切る。
        const { envelope, dek } = get();
        if (settings.autoLockMinutes === 0 && envelope !== null && dek !== null) {
          saveSessionDek(envelope, dek);
        } else {
          clearSessionDek();
        }
      }
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
        const now = new Date().toISOString();
        const tombstones = mergeTombstones(get().tombstones, [{ id, deletedAt: now }]);
        await persist(
          get().accounts.filter((a) => a.id !== id),
          tombstones,
        );
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
      lifecycleGeneration += 1;
      unlockSession += 1;
      clearSessionDek();
      await writeVault(envelope, token === null ? null : 0);
      if (token === null) await deleteToken();
      else await writeToken(token);
      // 置き換えたボルトに、前のボルトのパスキー登録を残さない（DEK が同じものだけ活かす）。
      await syncPasskeys(envelope);
      set({
        status: 'locked',
        envelope,
        dek: null,
        accounts: [],
        tombstones: [],
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
      const generation = lifecycleGeneration;
      const vaultId = await deriveVaultId(token);
      const remote = await syncClient.get(vaultId, token);
      if (get().envelope !== before || generation !== lifecycleGeneration) throw new VaultChangedError();
      lifecycleGeneration += 1;
      unlockSession += 1;
      // 別のボルトへ切り替えたら、前のボルトのセッションは使わない。
      clearSessionDek();
      // 置き換え前に、以前のボルト用の同期タイマーを止める。
      if (syncTimer !== null) {
        clearTimeout(syncTimer);
        syncTimer = null;
      }
      await writeVault(remote.envelope, remote.revision);
      await writeToken(token);
      await syncPasskeys(remote.envelope);
      set({
        status: 'locked',
        envelope: remote.envelope,
        dek: null,
        accounts: [],
        tombstones: [],
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
      // UI 以外から呼ばれても短いパスワードでゼロ知識モデルを崩さない。
      if (next.length < MIN_PASSWORD_LENGTH) return false;
      return runExclusive(async () => {
        // PBKDF2 を 2 回待つ間に保存が走らないよう、キューの内側で最新状態を読む。
        const { envelope, dek, token, accounts, tombstones } = get();
        const generation = lifecycleGeneration;
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
          JSON.stringify({ accounts: sortAccounts(accounts), tombstones }),
          envelope.revision + 1,
          new Date().toISOString(),
        );
        // 待機中に削除・置換されていたら保存しない（削除したボルトを復元しない）。
        if (generation !== lifecycleGeneration || get().envelope !== envelope) return false;
        await writeVault(updated, get().syncedRevision);
        set({ envelope: updated, syncState: token === null ? 'local-only' : 'pending' });
        // 再ラップで封筒の指紋が変わったので、セッション継続用の DEK を今の封筒で預け直す。
        if (get().settings.autoLockMinutes === 0) saveSessionDek(updated, dek);
        // DEK は変わらないのでパスキーはそのまま使える。保存している指紋だけ新しくする。
        await syncPasskeys(updated);
        if (token !== null) scheduleSync();
        return true;
      });
    },

    async syncNow() {
      // 送信は 1 本ずつ順に実行する（待機中の呼び出しも同じチェーンに並ぶ）。
      const generation = lifecycleGeneration;
      const vaultId = get().vaultId;
      const run = syncChain.then(async () => {
        // 待機中にボルトが置き換わった／消えたら、この送信は行わない。
        if (generation !== lifecycleGeneration || get().vaultId !== vaultId) return;
        await runSync();
      });
      syncChain = run.catch(() => undefined);
      await run;
    },

    async refreshRemote() {
      await refreshRemote();
    },

    async resolveConflict(mode) {
      // 読み取りから保存までをキューの内側で行う（同時に走る保存を取りこぼさない）。
      const result = await runExclusive(async () => {
        const generation = lifecycleGeneration;
        const session = unlockSession;
        const { conflict, token, vaultId, envelope, dek } = get();
        if (conflict === null || token === null || vaultId === null) {
          return { added: 0, updated: 0, resolved: false, shouldSync: false };
        }

        if (mode === 'discard') {
          // 置き換え前に、古い envelope を送るタイマーを止める。
          if (syncTimer !== null) {
            clearTimeout(syncTimer);
            syncTimer = null;
          }
          await writeVault(conflict.remoteEnvelope, conflict.remoteRevision);
          set({
            envelope: conflict.remoteEnvelope,
            conflict: null,
            syncState: 'synced',
            syncedRevision: conflict.remoteRevision,
          });
          if (dek !== null) {
            try {
              const data = parseVaultData(await decryptVaultDataWithDek(conflict.remoteEnvelope, dek));
              // 復号中にロックされたら平文は戻さない（次回の解錠で読み込む）。
              if (session === unlockSession && get().dek !== null) {
                set({ accounts: sortAccounts(data.accounts), tombstones: data.tombstones ?? [] });
              }
            } catch {
              if (session === unlockSession) set({ status: 'locked', dek: null, accounts: [], tombstones: [] });
            }
          }
          return { added: 0, updated: 0, resolved: true, shouldSync: false };
        }

        if (envelope === null || dek === null) {
          return { added: 0, updated: 0, resolved: false, shouldSync: false };
        }

        let accounts = get().accounts;
        let tombstones = get().tombstones;
        let added = 0;
        let updated = 0;
        if (mode === 'merge') {
          try {
            const plaintext = await decryptVaultDataWithDek(conflict.remoteEnvelope, dek);
            const merged = mergeVaultData({ accounts, tombstones }, parseVaultData(plaintext));
            accounts = merged.data.accounts;
            tombstones = merged.data.tombstones ?? [];
            added = merged.added;
            updated = merged.updated;
          } catch (error) {
            if (error instanceof CryptoError) {
              set({ conflict: null, status: 'locked', dek: null, accounts: [], tombstones: [] });
              return { added: 0, updated: 0, resolved: false, shouldSync: false };
            }
            throw error;
          }
        }

        const revision = conflict.remoteRevision + 1;
        const next = await updateEnvelopeData(
          envelope,
          dek,
          JSON.stringify({ accounts: sortAccounts(accounts), tombstones }),
          revision,
          new Date().toISOString(),
        );
        // 暗号化の待機中に削除・置換されていたら保存しない（削除したボルトを復元しない）。
        if (generation !== lifecycleGeneration || get().envelope !== envelope) {
          return { added: 0, updated: 0, resolved: false, shouldSync: false };
        }
        await writeVault(next, conflict.remoteRevision);
        if (session !== unlockSession || get().dek === null) {
          set({ envelope: next, conflict: null, syncedRevision: conflict.remoteRevision, syncState: 'pending' });
        } else {
          set({
            envelope: next,
            accounts: sortAccounts(accounts),
            tombstones,
            conflict: null,
            syncedRevision: conflict.remoteRevision,
            syncState: 'pending',
          });
        }
        // 暗号文の送信は平文を必要としない（ロック後でも送る）。
        return { added, updated, resolved: true, shouldSync: true };
      });

      if (result.shouldSync) await get().syncNow();
      return { added: result.added, updated: result.updated, resolved: result.resolved };
    },

    /**
     * バックアップ封筒を取り込む。
     * - replace: 封筒をそのまま差し替える（別ボルトのバックアップも可）。
     * - merge: バックアップ自身のパスワードで復号し、現在のボルトへ統合して現在の DEK で保存する。
     */
    async importEnvelope(envelope, mode, password) {
      if (mode === 'replace') {
        // 置き換えでも、渡されたパスワードで解錠できることを確かめてから保存する
        // （誤ったパスワードでバックアップを適用すると、解錠できないボルトになる）。
        if (password === undefined || password === '') throw new WrongPasswordError();
        const beforeReplace = get().envelope;
        await unlockVaultEnvelope(envelope, password);
        // 検証中に接続（attachSync）や初期化（wipe）でボルトが変わったら置き換えない。
        if (get().envelope !== beforeReplace) throw new VaultChangedError();
        clearSessionDek();
        const token = get().token;
        await writeVault(envelope, token === null ? null : 0);
        // 別ボルトのバックアップなら旧登録は使えない。同じ DEK のバックアップなら残る。
        await syncPasskeys(envelope);
        set({
          envelope,
          status: 'locked',
          dek: null,
          accounts: [],
          tombstones: [],
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
      const incoming = parseVaultData(unlocked.plaintext);
      // マージ結果の計算もキューの内側で行う（未完了の保存を取りこぼさない）。
      return runExclusive(async () => {
        const latest = get();
        if (latest.dek === null || latest.status !== 'unlocked') throw new VaultLockedError();
        const merged = mergeVaultData(
          { accounts: latest.accounts, tombstones: latest.tombstones },
          incoming,
        );
        await persist(merged.data.accounts, merged.data.tombstones ?? []);
        return merged.added + merged.updated;
      });
    },

    async wipe() {
      // 消したボルトの DEK は残さない（「自動ロック：なし」のセッションも打ち切る）。
      clearSessionDek();
      // 進行中の保存が削除後に書き戻さないよう、先に世代を進める。
      const { vaultId, token } = get();
      const generation = lifecycleGeneration + 1;
      lifecycleGeneration = generation;
      unlockSession += 1;
      // デバウンス中の送信を取り消し、進行中の送信が終わるのを待つ。
      // これをしないと、DELETE の後に PUT が確定して行が作り直される。
      if (syncTimer !== null) {
        clearTimeout(syncTimer);
        syncTimer = null;
      }
      // 待機中の送信を含むチェーンが終わるのを待つ（世代を進めたので何も送らない）。
      await syncChain;
      if (generation === lifecycleGeneration && syncTimer !== null) {
        clearTimeout(syncTimer);
        syncTimer = null;
      }
      // 先にローカルを消す（置き換えられた場合に新しいボルトを消さないため）。
      // 保存キューの中で実行し、進行中の保存が削除後に書き戻さないようにする。
      await runExclusive(() => deleteVault());
      if (generation !== lifecycleGeneration) {
        // 待機中に別のボルトが作られた／接続された → 状態は触らない。
        return;
      }
      set({
        status: 'uninitialized',
        accounts: [],
        tombstones: [],
        envelope: null,
        dek: null,
        passkeys: [],
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
      // サーバー側の暗号文も消す（残すとユーザーが後から削除する手段を失う）。
      // 失敗してもローカルは消えているので、そのまま終える。
      if (vaultId !== null && token !== null) {
        try {
          await syncClient.remove(vaultId, token);
        } catch {
          // オフライン等でもローカル削除は完了させる。
        }
      }
    },
  };
});
