/**
 * ボルトの状態。平文の秘密鍵と DEK はアンロック中のみメモリに置く。
 * 永続化するのは暗号文封筒だけ。
 *
 * 書き込みは 1 本のキューで直列化する（同時保存で先の変更が失われないように）。
 *
 * 1 つのブラウザに複数のプロファイル（独立したボルト）を置ける。状態はいつも
 * 「選択中のプロファイル」のものだけを持ち、切り替えるときは保存先も切り替える。
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
import { purgeExpiredTrash } from '../../shared/trash';
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
import { DEFAULT_PROFILE_ID, MAX_PROFILE_NAME_LENGTH, MIN_PASSWORD_LENGTH } from '../../shared/types';
import type {
  Account,
  PasskeyRecord,
  SyncDevice,
  Tombstone,
  VaultData,
  VaultEnvelope,
  VaultProfile,
} from '../../shared/types';
import { deriveVaultId, generateSyncToken } from '../../shared/sync';
import {
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
  updateSyncedRevision,
  writeActiveProfileId,
  writeSettings,
  writeToken,
  writeVault,
} from './storage';
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from './settings';
import { clearSessionDek, envelopeFingerprint, readSessionDek, saveSessionDek } from './sessionKey';
import {
  getDeviceIdentity,
  getDeviceId,
  getDeviceName,
  setDeviceName as persistDeviceName,
  touchDevice,
} from './device';
import { SyncConflictError, SyncHttpError, SyncNotFoundError, createSyncClient } from './syncClient';

export type VaultStatus = 'loading' | 'uninitialized' | 'locked' | 'unlocked';

export type SyncState = 'local-only' | 'synced' | 'pending' | 'error' | 'conflict';

/** 一覧の並べ替え。 */
export type SortMode = 'manual' | 'usage' | 'name';

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

/** アプリへ引き渡す前の初回同期に失敗した（オフライン・サーバー側の拒否など）。 */
export class AppLoginSyncError extends Error {
  constructor() {
    super('app_login_sync_failed');
    this.name = 'AppLoginSyncError';
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
  /** 同期している端末の一覧（暗号化ペイロードの中身） */
  devices: SyncDevice[];
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
  /** このブラウザにあるプロファイル（ボルト）の一覧 */
  profiles: VaultProfile[];
  /** 選択中のプロファイル ID */
  activeProfileId: string | null;
  /** この端末の ID（同期端末一覧用・ローカル生成） */
  deviceId: string;
  /** この端末の名前（変更可） */
  deviceName: string;

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
  restoreAccount: (id: string) => Promise<void>;
  purgeAccount: (id: string) => Promise<void>;
  emptyTrash: () => Promise<void>;
  recordUsage: (id: string) => Promise<void>;
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
  createProfile: (name: string) => Promise<string>;
  switchProfile: (id: string) => Promise<void>;
  renameProfile: (id: string, name: string) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  renameDevice: (name: string) => Promise<void>;
  forgetDevice: (id: string) => Promise<void>;
  /** 「アプリでログイン」用に、同期コードとアンロック中の DEK をそろえる。 */
  prepareAppLogin: () => Promise<{ token: string; dek: Uint8Array; vaultName: string }>;
};

export const syncClient = createSyncClient();

const SYNC_DEBOUNCE_MS = 2000;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

/** 保存処理の直列化キュー。後から始まった保存が先の変更を取りこぼさない。 */
let writeQueue: Promise<unknown> = Promise.resolve();

/** 同期送信の直列化チェーン（待機中の呼び出しも含めて順に実行する）。 */
let syncChain: Promise<void> = Promise.resolve();

/**
 * ボルトの世代。作成・置換・接続・削除・プロファイル切替で進む。
 * 待機中に別のライフサイクル操作が完了したら、古い保存を確定しないために使う。
 */
let lifecycleGeneration = 0;

/**
 * アンロック中のセッション。アンロック・ロック・削除・置換・接続・切替で進む。
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

/** 手動順（ピン留め優先）。保存する順序は常にこれを使う。 */
function manualSort(accounts: readonly Account[]): Account[] {
  return [...accounts].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/** 表示用の並べ替え。保存する順序は変えない（manualSort のまま）。 */
export function sortAccounts(
  accounts: readonly Account[],
  mode: SortMode = 'manual',
): Account[] {
  if (mode === 'usage') {
    const base = manualSort(accounts);
    return base.sort((a, b) => {
      const used = (b.useCount ?? 0) - (a.useCount ?? 0);
      if (used !== 0) return used;
      const lastA = a.lastUsedAt ?? '';
      const lastB = b.lastUsedAt ?? '';
      if (lastA !== lastB) return lastB.localeCompare(lastA);
      return 0;
    });
  }
  if (mode === 'name') {
    const base = manualSort(accounts);
    return base.sort((a, b) => {
      // ピン留めは名前順でも先頭に置く（探しやすさを優先）。
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const nameA = (a.issuer || a.label).toLocaleLowerCase();
      const nameB = (b.issuer || b.label).toLocaleLowerCase();
      return nameA.localeCompare(nameB, 'ja') || a.label.localeCompare(b.label, 'ja');
    });
  }
  return manualSort(accounts);
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
  const devices = Array.isArray(parsed.devices)
    ? parsed.devices.filter(
        (item): item is SyncDevice =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as SyncDevice).id === 'string' &&
          (item as SyncDevice).id !== '',
      )
    : [];
  return { accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [], tombstones, devices };
}

function nextOrder(accounts: readonly Account[]): number {
  return accounts.reduce((max, account) => Math.max(max, account.order), -1) + 1;
}

/** プロファイル名を整える（空なら 'メイン'）。 */
export function normaliseProfileName(raw: string): string {
  const trimmed = raw.trim().slice(0, MAX_PROFILE_NAME_LENGTH);
  return trimmed === '' ? 'メイン' : trimmed;
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
  async function persist(
    accounts: Account[],
    tombstones: Tombstone[] = get().tombstones,
    devicesOverride?: SyncDevice[],
  ): Promise<void> {
    const { dek, envelope, token, activeProfileId } = get();
    if (dek === null || envelope === null || activeProfileId === null) return;
    const generation = lifecycleGeneration;
    const session = unlockSession;
    const now = new Date().toISOString();
    // 期限切れのゴミ箱は保存のたびに完全削除へ進める。
    const purged = purgeExpiredTrash(accounts, tombstones, Date.now());
    // 保存 = push なので、自端末の最終同期時刻をここで更新する。
    const devices = touchDevice(devicesOverride ?? get().devices, getDeviceIdentity(), now);
    const revision = envelope.revision + 1;
    const next = await updateEnvelopeData(
      envelope,
      dek,
      JSON.stringify({
        accounts: manualSort(purged.accounts),
        tombstones: purged.tombstones,
        ...(devices.length === 0 ? {} : { devices }),
      } satisfies VaultData),
      revision,
      now,
    );
    // 暗号化の待機中に削除・置換・切替されていたら保存しない（削除したボルトを復元しない）。
    if (generation !== lifecycleGeneration || get().envelope !== envelope) return;
    await writeVault(activeProfileId, next, get().syncedRevision);
    // 同じボルトへの保存は有効。ただし待機中にロックされたら平文は戻さない。
    if (session !== unlockSession || get().dek === null) {
      set({
        envelope: next,
        devices,
        tombstones: purged.tombstones,
        syncState: token === null ? 'local-only' : 'pending',
      });
    } else {
      set({
        envelope: next,
        accounts: manualSort(purged.accounts),
        tombstones: purged.tombstones,
        devices,
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
  async function syncPasskeys(
    profileId: string,
    envelope: VaultEnvelope | null,
  ): Promise<PasskeyRecord[]> {
    if (envelope === null) {
      await deleteAllPasskeys(profileId);
      set({ passkeys: [] });
      return [];
    }
    const stored = await readPasskeys(profileId);
    const valid = validPasskeysForEnvelope(stored, envelope);
    const rebound = bindPasskeysToFingerprint(valid, envelopeFingerprint(envelope));
    const unchanged =
      stored.length === valid.length && rebound.every((record, index) => record === valid[index]);
    if (!unchanged) await replacePasskeys(profileId, rebound);
    set({ passkeys: rebound });
    return rebound;
  }

  /** 選べるプロファイルが 1 つも無い状態を作らない。 */
  async function ensureProfiles(): Promise<{ profiles: VaultProfile[]; activeId: string }> {
    let profiles = await listProfiles();
    if (profiles.length === 0) {
      const created: VaultProfile = {
        id: DEFAULT_PROFILE_ID,
        name: 'メイン',
        createdAt: new Date().toISOString(),
      };
      await putProfile(created);
      profiles = [created];
    }
    const storedActive = await readActiveProfileId();
    const activeId =
      storedActive !== null && profiles.some((profile) => profile.id === storedActive)
        ? storedActive
        : (profiles[0] as VaultProfile).id;
    if (activeId !== storedActive) await writeActiveProfileId(activeId);
    set({ profiles });
    return { profiles, activeId };
  }

  /** 選択中のプロファイルのボルトを読み込み、状態をそのボルトへ差し替える。 */
  async function loadProfile(profileId: string): Promise<void> {
    const [stored, token] = await Promise.all([readVault(profileId), readToken(profileId)]);
    const settings = get().settings;
    if (stored === null) {
      clearSessionDek(profileId);
      await syncPasskeys(profileId, null);
      set({
        status: 'uninitialized',
        activeProfileId: profileId,
        envelope: null,
        dek: null,
        accounts: [],
        tombstones: [],
        devices: [],
        token,
        vaultId: null,
        syncedRevision: null,
        syncState: 'local-only',
        syncError: null,
        lastSyncedAt: null,
        conflict: null,
        failedAttempts: 0,
        cooldownUntil: 0,
        pendingSyncToken: null,
      });
      return;
    }
    const syncedRevision = stored.syncedRevision;
    // 今の封筒で使えないパスキーはここで落とす（ボルトを入れ替えた残骸を残さない）。
    await syncPasskeys(profileId, stored.envelope);
    const pending =
      token !== null && (syncedRevision === null || syncedRevision !== stored.envelope.revision);
    const base = {
      activeProfileId: profileId,
      envelope: stored.envelope,
      token,
      vaultId: token === null ? null : await deriveVaultId(token),
      syncedRevision: token === null ? null : syncedRevision,
      syncState: (token === null ? 'local-only' : pending ? 'pending' : 'synced') as SyncState,
      lastSyncedAt: token === null ? null : stored.savedAt,
      conflict: null,
      syncError: null,
      failedAttempts: 0,
      cooldownUntil: 0,
    };
    // 自動ロック「なし」のときだけ、同じタブの再読み込みでアンロック状態を復帰する
    // （預けた DEK はタブを閉じる・手動ロック・設定変更で消える）。
    if (settings.autoLockMinutes === 0) {
      const dek = readSessionDek(stored.envelope, profileId);
      if (dek !== null) {
        try {
          const raw = parseVaultData(await decryptVaultDataWithDek(stored.envelope, dek));
          const purged = purgeExpiredTrash(raw.accounts, raw.tombstones ?? [], Date.now());
          unlockSession += 1;
          set({
            ...base,
            status: 'unlocked',
            dek,
            accounts: manualSort(purged.accounts),
            tombstones: purged.tombstones,
            devices: raw.devices ?? [],
          });
          void refreshRemote();
          if (pending) scheduleSync();
          if (purged.purged > 0) {
            void runExclusive(async () => {
              if (get().dek !== null) await persist(purged.accounts, purged.tombstones);
            });
          }
          return;
        } catch {
          // 復号できなければ（封筒が壊れている等）通常どおりロック画面にする。
          clearSessionDek(profileId);
        }
      }
    }
    set({
      ...base,
      status: 'locked',
      dek: null,
      accounts: [],
      tombstones: [],
      devices: [],
      pendingSyncToken: null,
    });
    // 未同期の変更が残っている場合は、ロック画面のままでも送信を試みる。
    if (pending) scheduleSync();
  }

  /** 実際の送信処理（syncNow は 1 本ずつ直列化して呼ぶ）。 */
  async function runSync(): Promise<void> {
    const { token, vaultId, envelope } = get();
    if (token === null || vaultId === null || envelope === null) return;
    // 待機中にボルトが置き換わった／消えたら、状態も保存先も触らない。
    const generation = lifecycleGeneration;
    const profileId = get().activeProfileId;
    const isCurrent = (): boolean =>
      generation === lifecycleGeneration && get().vaultId === vaultId;
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
      if (profileId !== null) await updateSyncedRevision(profileId, sent.revision);
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
            if (profileId !== null) await updateSyncedRevision(profileId, remote.revision);
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
          if (profileId !== null) await updateSyncedRevision(profileId, sent.revision);
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
    devices: [],
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
    profiles: [],
    activeProfileId: null,
    deviceId: getDeviceId(),
    deviceName: getDeviceName(),

    acknowledgeSyncToken() {
      set({ pendingSyncToken: null });
    },

    flushSync,

    async initialize() {
      const settings = await readSettings<unknown>();
      const normalized = normalizeSettings(settings);
      set({ settings: normalized });
      const { activeId } = await ensureProfiles();
      await loadProfile(activeId);
    },

    async createVault(password, options) {
      if (password.length < MIN_PASSWORD_LENGTH) throw new Error('password_too_short');
      const profileId = get().activeProfileId ?? DEFAULT_PROFILE_ID;
      // 作り直したボルトに、前のボルトのセッション DEK を引き継がない。
      clearSessionDek(profileId);
      lifecycleGeneration += 1;
      const token = options.sync ? generateSyncToken() : null;
      const dek = await generateDek();
      const devices = touchDevice([], getDeviceIdentity(), new Date().toISOString());
      const envelope = await createVaultEnvelope({
        password,
        dek,
        plaintext: JSON.stringify({ accounts: [], tombstones: [], devices } satisfies VaultData),
        revision: 1,
      });
      const vaultId = token === null ? null : await deriveVaultId(token);
      await writeVault(profileId, envelope, token === null ? null : 0);
      if (token !== null) await writeToken(profileId, token);
      // 新しいボルトに前のボルトのパスキー登録を引き継がない。
      await syncPasskeys(profileId, envelope);
      set({
        status: 'unlocked',
        envelope,
        accounts: [],
        tombstones: [],
        devices,
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
        const { envelope, cooldownUntil, activeProfileId } = get();
        if (envelope === null || activeProfileId === null) return { ok: false };
        const now = Date.now();
        if (cooldownUntil > now) {
          return { ok: false, cooldownSeconds: Math.ceil((cooldownUntil - now) / 1000) };
        }
        try {
          const generation = lifecycleGeneration;
          const session = unlockSession;
          // 直前に確定した保存（IndexedDB の最新）を読み直してから復号する。
          const stored = await readVault(activeProfileId);
          const target = stored?.envelope ?? envelope;
          if (generation !== lifecycleGeneration || session !== unlockSession) return { ok: false };
          const unlocked = await unlockVaultEnvelope(target, password);
          // 復号中に接続（attachSync）・初期化（wipe）・ロックが起きたら結果を反映しない。
          if (generation !== lifecycleGeneration || session !== unlockSession) return { ok: false };
          const raw = parseVaultData(unlocked.plaintext);
          const purged = purgeExpiredTrash(raw.accounts, raw.tombstones ?? [], Date.now());
          unlockSession += 1;
          // 解錠できた封筒に合わせてパスキーの登録を棚卸しする（古い封筒の残骸を出さない）。
          await syncPasskeys(activeProfileId, target);
          set({
            status: 'unlocked',
            envelope: target,
            dek: unlocked.dek,
            accounts: manualSort(purged.accounts),
            tombstones: purged.tombstones,
            devices: raw.devices ?? [],
            failedAttempts: 0,
            cooldownUntil: 0,
          });
          // 自動ロック「なし」なら、このタブを開いている間は再読み込みで復帰できるようにする。
          if (get().settings.autoLockMinutes === 0) saveSessionDek(target, unlocked.dek, activeProfileId);
          void refreshRemote();
          if (purged.purged > 0) {
            void runExclusive(async () => {
              if (get().dek !== null) await persist(purged.accounts, purged.tombstones);
            });
          }
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
      const { dek, envelope, activeProfileId } = get();
      if (dek === null || envelope === null || activeProfileId === null) throw new VaultLockedError();
      if (!isPasskeyAvailable()) return { ok: false, reason: 'unavailable' };
      const name = rawName.trim().slice(0, 64) === '' ? 'パスキー' : rawName.trim().slice(0, 64);
      // 同じボルトのパスキーは salt を共有する（1 回の get でどの認証器でも同じ KEK になる）。
      const existing = validPasskeysForEnvelope(await readPasskeys(activeProfileId), envelope);
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
        if (current.dek === null || current.envelope === null || current.activeProfileId === null) {
          throw new VaultLockedError();
        }
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
        await putPasskey(current.activeProfileId, record);
        const stored = validPasskeysForEnvelope(
          await readPasskeys(current.activeProfileId),
          current.envelope,
        );
        set({ passkeys: stored });
        return { ok: true, record };
      });
    },

    async removePasskey(id) {
      const profileId = get().activeProfileId;
      if (profileId === null) return;
      await deletePasskey(id, profileId);
      set({ passkeys: get().passkeys.filter((record) => record.id !== id) });
    },

    /**
     * パスキー / セキュリティキーでアンロックする。マスターパスワードを入力しない経路。
     * 認証器を待つ間に保存が走っても取りこぼさないよう、読み取りから復号までキューの中で行う。
     */
    async unlockWithPasskey() {
      return runExclusive(async (): Promise<PasskeyUnlockResult> => {
        const { envelope, activeProfileId } = get();
        if (envelope === null || activeProfileId === null) return { ok: false, reason: 'failed' };
        if (!isPasskeyAvailable()) return { ok: false, reason: 'unavailable' };
        const generation = lifecycleGeneration;
        const session = unlockSession;
        const stored = await readVault(activeProfileId);
        const target = stored?.envelope ?? envelope;
        const candidates = validPasskeysForEnvelope(await readPasskeys(activeProfileId), target);
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
        const raw = parseVaultData(plaintext);
        const purged = purgeExpiredTrash(raw.accounts, raw.tombstones ?? [], Date.now());
        unlockSession += 1;
        set({
          status: 'unlocked',
          envelope: target,
          dek,
          accounts: manualSort(purged.accounts),
          tombstones: purged.tombstones,
          devices: raw.devices ?? [],
          failedAttempts: 0,
          cooldownUntil: 0,
          passkeys: candidates,
        });
        // 自動ロック「なし」なら、このタブを開いている間は再読み込みで復帰できるようにする。
        if (get().settings.autoLockMinutes === 0) saveSessionDek(target, dek, activeProfileId);
        void refreshRemote();
        if (purged.purged > 0) {
          void runExclusive(async () => {
            if (get().dek !== null) await persist(purged.accounts, purged.tombstones);
          });
        }
        return { ok: true };
      });
    },

    lock() {
      unlockSession += 1;
      // 手動ロックは、自動ロック「なし」のセッション継続も必ず打ち切る。
      clearSessionDek();
      // 2 秒デバウンス内の変更を取りこぼさない（syncNow は DEK を必要としない）。
      flushSync();
      set({ status: 'locked', dek: null, accounts: [], tombstones: [], devices: [], conflict: null });
    },

    async updateSettings(patch) {
      const previous = get().settings;
      const settings = { ...previous, ...patch };
      set({ settings });
      await writeSettings(settings);
      if (settings.autoLockMinutes !== previous.autoLockMinutes) {
        // 「なし」にしたら今のセッションを引き継ぎ、それ以外に変えたら即座に打ち切る。
        const { envelope, dek, activeProfileId } = get();
        if (settings.autoLockMinutes === 0 && envelope !== null && dek !== null) {
          saveSessionDek(envelope, dek, activeProfileId ?? DEFAULT_PROFILE_ID);
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

    /** ふつうの削除はゴミ箱へ移す（30 日なら復元できる。tombstone はまだ作らない）。 */
    async removeAccount(id) {
      await runExclusive(async () => {
        const now = new Date().toISOString();
        const next = get().accounts.map((account) =>
          account.id === id ? { ...account, deletedAt: now, updatedAt: now } : account,
        );
        await persist(next);
      });
    },

    async restoreAccount(id) {
      await runExclusive(async () => {
        const now = new Date().toISOString();
        const next = get().accounts.map((account) => {
          if (account.id !== id) return account;
          const { deletedAt: _deletedAt, ...rest } = account;
          return { ...rest, updatedAt: now };
        });
        await persist(next);
      });
    },

    /** 完全削除（取り消せない）。tombstone を残して他端末からの復活を防ぐ。 */
    async purgeAccount(id) {
      await runExclusive(async () => {
        const now = new Date().toISOString();
        const tombstones = mergeTombstones(get().tombstones, [{ id, deletedAt: now }]);
        await persist(
          get().accounts.filter((account) => account.id !== id),
          tombstones,
        );
      });
    },

    async emptyTrash() {
      await runExclusive(async () => {
        const now = new Date().toISOString();
        const trashed = get().accounts.filter(
          (account) => typeof account.deletedAt === 'string' && account.deletedAt !== '',
        );
        if (trashed.length === 0) return;
        const tombstones = mergeTombstones(
          get().tombstones,
          trashed.map((account) => ({ id: account.id, deletedAt: now })),
        );
        await persist(
          get().accounts.filter(
            (account) => !(typeof account.deletedAt === 'string' && account.deletedAt !== ''),
          ),
          tombstones,
        );
      });
    },

    /** コードを使った印を付ける（よく使う順のため）。updatedAt は変えない（同期を騒がせない）。 */
    async recordUsage(id) {
      await runExclusive(async () => {
        const accounts = get().accounts;
        const target = accounts.find((account) => account.id === id);
        if (target === undefined) return;
        const now = new Date().toISOString();
        const next = accounts.map((account) =>
          account.id === id
            ? { ...account, useCount: (account.useCount ?? 0) + 1, lastUsedAt: now }
            : account,
        );
        await persist(next);
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
      const profileId = get().activeProfileId ?? DEFAULT_PROFILE_ID;
      lifecycleGeneration += 1;
      unlockSession += 1;
      clearSessionDek(profileId);
      await writeVault(profileId, envelope, token === null ? null : 0);
      if (token === null) await deleteToken(profileId);
      else await writeToken(profileId, token);
      // 置き換えたボルトに、前のボルトのパスキー登録を残さない（DEK が同じものだけ活かす）。
      await syncPasskeys(profileId, envelope);
      set({
        status: 'locked',
        envelope,
        dek: null,
        accounts: [],
        tombstones: [],
        devices: [],
        token,
        vaultId: token === null ? null : await deriveVaultId(token),
        syncedRevision: token === null ? null : 0,
        syncState: token === null ? 'local-only' : 'synced',
        conflict: null,
        syncError: null,
      });
    },

    async attachSync(token) {
      const profileId = get().activeProfileId ?? DEFAULT_PROFILE_ID;
      // 取得中に別のボルトが作られた場合は、そのボルトを上書きしない。
      const before = get().envelope;
      const generation = lifecycleGeneration;
      const vaultId = await deriveVaultId(token);
      const remote = await syncClient.get(vaultId, token);
      if (get().envelope !== before || generation !== lifecycleGeneration) throw new VaultChangedError();
      lifecycleGeneration += 1;
      unlockSession += 1;
      // 別のボルトへ切り替えたら、前のボルトのセッションは使わない。
      clearSessionDek(profileId);
      // 置き換え前に、以前のボルト用の同期タイマーを止める。
      if (syncTimer !== null) {
        clearTimeout(syncTimer);
        syncTimer = null;
      }
      await writeVault(profileId, remote.envelope, remote.revision);
      await writeToken(profileId, token);
      await syncPasskeys(profileId, remote.envelope);
      set({
        status: 'locked',
        envelope: remote.envelope,
        dek: null,
        accounts: [],
        tombstones: [],
        devices: [],
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
      const { vaultId, token, activeProfileId } = get();
      const profileId = activeProfileId ?? DEFAULT_PROFILE_ID;
      if (vaultId !== null && token !== null) {
        try {
          await syncClient.remove(vaultId, token);
        } catch {
          // オフラインでもローカル側の同期設定は外す。
        }
      }
      await deleteToken(profileId);
      // await の間に persist が走っていても、最新の envelope / syncedRevision を保存する。
      const latest = get().envelope;
      if (latest !== null) await writeVault(profileId, latest, null);
      set({
        token: null,
        vaultId: null,
        syncedRevision: null,
        syncState: 'local-only',
        syncError: null,
        lastSyncedAt: null,
      });
    },

    /**
     * 「アプリでログイン」の準備。同期コードが未発行ならここで作って初回同期まで済ませる。
     *
     * アプリは同期コードでサーバーのボルトを取りに行くため、コードを渡す前に
     * サーバー側へ暗号文を置いておく必要がある（置いていなければアプリは
     * 「ボルトが見つからない」になる）。DEK はアンロック中のものだけを返す。
     */
    async prepareAppLogin() {
      const initial = get();
      if (initial.status !== 'unlocked' || initial.dek === null || initial.envelope === null) {
        throw new VaultLockedError();
      }
      const profileId = initial.activeProfileId ?? DEFAULT_PROFILE_ID;
      const generation = lifecycleGeneration;
      let token = initial.token;
      if (token === null) {
        token = generateSyncToken();
        const vaultId = await deriveVaultId(token);
        await writeToken(profileId, token);
        // 失敗してもコードは残す（次に押したときの再送で使える。設定画面にも出る）。
        set({
          token,
          vaultId,
          syncedRevision: null,
          syncState: 'pending',
          syncError: null,
          lastSyncedAt: null,
        });
      }
      // アプリはコードでサーバーのボルトを取りに行くので、未送信なら先に置いておく
      // （サーバーに無ければ base 0 で作られる）。
      if (get().syncedRevision === null) await get().syncNow();
      // 送信中に別のボルトへ切り替わった・消えた場合、そのコードは渡さない。
      if (generation !== lifecycleGeneration || get().token !== token) throw new VaultChangedError();
      if (get().syncedRevision === null || get().syncState === 'error') throw new AppLoginSyncError();
      const current = get();
      if (current.dek === null || current.status !== 'unlocked') throw new VaultLockedError();
      const vaultName = normaliseProfileName(
        current.profiles.find((profile) => profile.id === profileId)?.name ?? '',
      );
      return { token, dek: current.dek, vaultName };
    },

    async changePassword(current, next) {
      // UI 以外から呼ばれても短いパスワードでゼロ知識モデルを崩さない。
      if (next.length < MIN_PASSWORD_LENGTH) return false;
      return runExclusive(async () => {
        // PBKDF2 を 2 回待つ間に保存が走らないよう、キューの内側で最新状態を読む。
        const { envelope, dek, token, accounts, tombstones, devices, activeProfileId } = get();
        const generation = lifecycleGeneration;
        const profileId = activeProfileId ?? DEFAULT_PROFILE_ID;
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
          JSON.stringify({
            accounts: manualSort(accounts),
            tombstones,
            ...(devices.length === 0 ? {} : { devices }),
          } satisfies VaultData),
          envelope.revision + 1,
          new Date().toISOString(),
        );
        // 待機中に削除・置換・切替されていたら保存しない（削除したボルトを復元しない）。
        if (generation !== lifecycleGeneration || get().envelope !== envelope) return false;
        await writeVault(profileId, updated, get().syncedRevision);
        set({ envelope: updated, syncState: token === null ? 'local-only' : 'pending' });
        // 再ラップで封筒の指紋が変わったので、セッション継続用の DEK を今の封筒で預け直す。
        if (get().settings.autoLockMinutes === 0) saveSessionDek(updated, dek, profileId);
        // DEK は変わらないのでパスキーはそのまま使える。保存している指紋だけ新しくする。
        await syncPasskeys(profileId, updated);
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
        const { conflict, token, vaultId, envelope, dek, activeProfileId } = get();
        const profileId = activeProfileId ?? DEFAULT_PROFILE_ID;
        if (conflict === null || token === null || vaultId === null) {
          return { added: 0, updated: 0, resolved: false, shouldSync: false };
        }

        if (mode === 'discard') {
          // 置き換え前に、古い envelope を送るタイマーを止める。
          if (syncTimer !== null) {
            clearTimeout(syncTimer);
            syncTimer = null;
          }
          await writeVault(profileId, conflict.remoteEnvelope, conflict.remoteRevision);
          set({
            envelope: conflict.remoteEnvelope,
            conflict: null,
            syncState: 'synced',
            syncedRevision: conflict.remoteRevision,
          });
          if (dek !== null) {
            try {
              const raw = parseVaultData(await decryptVaultDataWithDek(conflict.remoteEnvelope, dek));
              // 復号中にロックされたら平文は戻さない（次回の解錠で読み込む）。
              if (session === unlockSession && get().dek !== null) {
                set({
                  accounts: manualSort(raw.accounts),
                  tombstones: raw.tombstones ?? [],
                  devices: raw.devices ?? [],
                });
              }
            } catch {
              if (session === unlockSession) {
                set({ status: 'locked', dek: null, accounts: [], tombstones: [], devices: [] });
              }
            }
          }
          return { added: 0, updated: 0, resolved: true, shouldSync: false };
        }

        if (envelope === null || dek === null) {
          return { added: 0, updated: 0, resolved: false, shouldSync: false };
        }

        let accounts = get().accounts;
        let tombstones = get().tombstones;
        let devices = get().devices;
        let added = 0;
        let updated = 0;
        if (mode === 'merge') {
          try {
            const plaintext = await decryptVaultDataWithDek(conflict.remoteEnvelope, dek);
            const merged = mergeVaultData(
              { accounts, tombstones, devices },
              parseVaultData(plaintext),
            );
            accounts = merged.data.accounts;
            tombstones = merged.data.tombstones ?? [];
            devices = merged.data.devices ?? devices;
            added = merged.added;
            updated = merged.updated;
          } catch (error) {
            if (error instanceof CryptoError) {
              set({ conflict: null, status: 'locked', dek: null, accounts: [], tombstones: [], devices: [] });
              return { added: 0, updated: 0, resolved: false, shouldSync: false };
            }
            throw error;
          }
        }

        const revision = conflict.remoteRevision + 1;
        const next = await updateEnvelopeData(
          envelope,
          dek,
          JSON.stringify({
            accounts: manualSort(accounts),
            tombstones,
            ...(devices.length === 0 ? {} : { devices }),
          } satisfies VaultData),
          revision,
          new Date().toISOString(),
        );
        // 暗号化の待機中に削除・置換・切替されていたら保存しない（削除したボルトを復元しない）。
        if (generation !== lifecycleGeneration || get().envelope !== envelope) {
          return { added: 0, updated: 0, resolved: false, shouldSync: false };
        }
        await writeVault(profileId, next, conflict.remoteRevision);
        if (session !== unlockSession || get().dek === null) {
          set({ envelope: next, conflict: null, syncedRevision: conflict.remoteRevision, syncState: 'pending' });
        } else {
          set({
            envelope: next,
            accounts: manualSort(accounts),
            tombstones,
            devices,
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
      const profileId = get().activeProfileId ?? DEFAULT_PROFILE_ID;
      if (mode === 'replace') {
        // 置き換えでも、渡されたパスワードで解錠できることを確かめてから保存する
        // （誤ったパスワードでバックアップを適用すると、解錠できないボルトになる）。
        if (password === undefined || password === '') throw new WrongPasswordError();
        const beforeReplace = get().envelope;
        await unlockVaultEnvelope(envelope, password);
        // 検証中に接続（attachSync）や初期化（wipe）でボルトが変わったら置き換えない。
        if (get().envelope !== beforeReplace) throw new VaultChangedError();
        clearSessionDek(profileId);
        const token = get().token;
        await writeVault(profileId, envelope, token === null ? null : 0);
        // 別ボルトのバックアップなら旧登録は使えない。同じ DEK のバックアップなら残る。
        await syncPasskeys(profileId, envelope);
        set({
          envelope,
          status: 'locked',
          dek: null,
          accounts: [],
          tombstones: [],
          devices: [],
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
          { accounts: latest.accounts, tombstones: latest.tombstones, devices: latest.devices },
          incoming,
        );
        await persist(
          merged.data.accounts,
          merged.data.tombstones ?? [],
          merged.data.devices ?? latest.devices,
        );
        return merged.added + merged.updated;
      });
    },

    async wipe() {
      // 消したボルトの DEK は残さない（「自動ロック：なし」のセッションも打ち切る）。
      clearSessionDek();
      // 進行中の保存が削除後に書き戻さないよう、先に世代を進める。
      const { vaultId, token, activeProfileId } = get();
      const profileId = activeProfileId ?? DEFAULT_PROFILE_ID;
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
      await runExclusive(() => deleteVault(profileId));
      if (generation !== lifecycleGeneration) {
        // 待機中に別のボルトが作られた／接続された／切り替えた → 状態は触らない。
        return;
      }
      set({
        status: 'uninitialized',
        accounts: [],
        tombstones: [],
        devices: [],
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
        pendingSyncToken: null,
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

    /** 新しいプロファイルを作り、そのまま切り替える（中身は空なので設定画面で作成する）。 */
    async createProfile(name) {
      const profile: VaultProfile = {
        id: makeAccountId(),
        name: normaliseProfileName(name),
        createdAt: new Date().toISOString(),
      };
      await putProfile(profile);
      set({ profiles: [...get().profiles, profile] });
      await get().switchProfile(profile.id);
      return profile.id;
    },

    async switchProfile(id) {
      const current = get();
      if (id === current.activeProfileId) return;
      const known = current.profiles.find((profile) => profile.id === id) ?? (await readProfile(id));
      if (known === null) return;
      // 切替前に、今のプロファイルの未送信分を確定させる（新しい envelope を送らないよう世代も進める）。
      if (syncTimer !== null) {
        clearTimeout(syncTimer);
        syncTimer = null;
      }
      await syncChain;
      lifecycleGeneration += 1;
      unlockSession += 1;
      await writeActiveProfileId(id);
      // 表示上の状態を先に空にして、切替中に前のプロファイルの平文が残らないようにする。
      set({ dek: null, accounts: [], tombstones: [], devices: [], conflict: null, envelope: null });
      await loadProfile(id);
    },

    async renameProfile(id, name) {
      const next = normaliseProfileName(name);
      const profile = get().profiles.find((item) => item.id === id) ?? (await readProfile(id));
      if (profile === null) return;
      const updated: VaultProfile = { ...profile, name: next };
      await putProfile(updated);
      set({
        profiles: get().profiles.map((item) => (item.id === id ? updated : item)),
      });
    },

    async deleteProfile(id) {
      const { profiles, activeProfileId } = get();
      // 最後の 1 つは消さない（消したいときは中身の初期化を使う）。
      if (profiles.length <= 1) return;
      await deleteProfileRecord(id);
      const remaining = profiles.filter((profile) => profile.id !== id);
      set({ profiles: remaining });
      if (activeProfileId === id) {
        const next = remaining[0];
        if (next !== undefined) await get().switchProfile(next.id);
      }
    },

    async renameDevice(name) {
      const trimmed = name.trim().slice(0, 64);
      if (trimmed === '') return;
      persistDeviceName(trimmed);
      set({ deviceName: getDeviceName() });
      await runExclusive(() => persist(get().accounts, get().tombstones));
    },

    async forgetDevice(id) {
      const { devices } = get();
      const filtered = devices.filter((device) => device.id !== id);
      if (filtered.length === devices.length) return;
      await runExclusive(() => persist(get().accounts, get().tombstones, filtered));
    },
  };
});
