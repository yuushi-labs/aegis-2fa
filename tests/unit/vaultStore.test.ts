/**
 * ボルトストア（クライアント状態 + 永続化 + 同期）の単体テスト。
 *
 * IndexedDB（./storage）と同期 API（./syncClient）はメモリ実装に差し替え、
 * 暗号処理は本物を使う（shared/crypto）。暗号化だけは任意のタイミングで
 * 止められるようラップし、保存中にロック・削除・置換が起きた場合の競合を再現する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToBase64 } from '../../shared/encoding';
import { isValidSyncToken } from '../../shared/sync';
import { envelopeFingerprint } from '../../src/lib/sessionKey';
import type {
  Account,
  PasskeyRecord,
  SyncDevice,
  Tombstone,
  VaultEnvelope,
  VaultProfile,
} from '../../shared/types';
import type * as CryptoModule from '../../shared/crypto';
import type * as VaultStoreModule from '../../src/lib/vaultStore';

/** フェイクタイマー導入前に確保しておく本物の setTimeout（暗号処理の完了待ちに使う）。 */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

const H = vi.hoisted(() => {
  class SyncHttpError extends Error {
    constructor(
      readonly status: number,
      readonly body: unknown,
    ) {
      super(`sync request failed: ${status}`);
      this.name = 'SyncHttpError';
    }
  }

  class SyncConflictError extends Error {
    constructor(readonly currentRevision: number) {
      super('sync conflict');
      this.name = 'SyncConflictError';
    }
  }

  class SyncNotFoundError extends Error {
    constructor() {
      super('vault not found');
      this.name = 'SyncNotFoundError';
    }
  }

  class PasskeyCancelledError extends Error {
    constructor() {
      super('cancelled');
      this.name = 'PasskeyCancelledError';
    }
  }

  class PasskeyPrfUnsupportedError extends Error {
    constructor() {
      super('prf unsupported');
      this.name = 'PasskeyPrfUnsupportedError';
    }
  }

  class PasskeyUnavailableError extends Error {
    constructor() {
      super('unavailable');
      this.name = 'PasskeyUnavailableError';
    }
  }

  /** base64 → バイト列（hoisted の中では import できないので自前で解決する）。 */
  function decodeBase64(input: string): Uint8Array {
    const binary = atob(input);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /**
   * テスト用の PRF 出力。同じ salt からは必ず同じ 32B を返す（実際の認証器も
   * credential + salt に対して安定した値を返す）。
   */
  async function fakePrf(salt: Uint8Array): Promise<Uint8Array> {
    const buffer = new ArrayBuffer(salt.byteLength);
    new Uint8Array(buffer).set(salt);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
    return new Uint8Array(digest);
  }

  type StoredVault = { envelope: VaultEnvelope; syncedRevision: number | null; savedAt: string };
  type Remote = { envelope: VaultEnvelope; revision: number };

  const harness = {
    vault: null as StoredVault | null,
    token: null as string | null,
    /** プロファイル（テストでは 1 つだけ使う単一ボルトの代替） */
    profiles: [] as VaultProfile[],
    activeProfileId: 'main' as string | null,
    settings: null as unknown,
    writes: [] as VaultEnvelope[],
    deletions: 0,
    passkeys: {
      records: [] as Array<{ id: string; [key: string]: unknown }>,
      /** 登録した認証器の数（credentialId の連番に使う） */
      issued: 0,
      /** PRF 出力を差し替える（食い違いの再現用） */
      outputOverride: null as Uint8Array | null,
      /** 未対応・キャンセルを再現する */
      createError: null as Error | null,
      assertError: null as Error | null,
      /** 提示させたい credentialId（既定は先頭） */
      chosenId: null as string | null,
      available: true,
      CancelledError: PasskeyCancelledError,
      PrfUnsupportedError: PasskeyPrfUnsupportedError,
      UnavailableError: PasskeyUnavailableError,
      fakePrf,
      decodeBase64,
    },
    server: {
      get: async (_vaultId: string, _token: string): Promise<Remote> => {
        throw new SyncNotFoundError();
      },
      put: async (
        _vaultId: string,
        _token: string,
        envelope: VaultEnvelope,
        _baseRevision: number,
      ): Promise<{ revision: number }> => ({
        revision: envelope.revision,
      }),
      remove: async (_vaultId: string, _token: string): Promise<void> => undefined,
      getMeta: async (
        _vaultId: string,
        _token: string,
      ): Promise<{ revision: number; updatedAt: string }> => ({
        revision: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    },
    client: {
      get: (vaultId: string, token: string) => harness.server.get(vaultId, token),
      put: (vaultId: string, token: string, envelope: VaultEnvelope, baseRevision: number) =>
        harness.server.put(vaultId, token, envelope, baseRevision),
      remove: (vaultId: string, token: string) => harness.server.remove(vaultId, token),
      getMeta: (vaultId: string, token: string) => harness.server.getMeta(vaultId, token),
      health: async () => true,
    },
    crypto: {
      gate: null as Promise<void> | null,
      onEntry: null as (() => void) | null,
    },
    errors: { SyncHttpError, SyncConflictError, SyncNotFoundError },
  };
  return harness;
});

vi.mock('../../src/lib/storage', () => ({
  DB_NAME: 'aegis-test',
  DB_VERSION: 3,
  DEFAULT_PROFILE_ID: 'main',
  resetStorageCache: () => undefined,
  listProfiles: async () =>
    H.profiles.length === 0
      ? [{ id: 'main', name: 'メイン', createdAt: '2026-01-01T00:00:00.000Z' }]
      : structuredClone(H.profiles),
  readProfile: async (id: string) => H.profiles.find((profile) => profile.id === id) ?? null,
  putProfile: async (profile: VaultProfile) => {
    H.profiles = [...H.profiles.filter((item) => item.id !== profile.id), structuredClone(profile)];
  },
  deleteProfileRecord: async (id: string) => {
    H.profiles = H.profiles.filter((profile) => profile.id !== id);
    if (H.activeProfileId === id) {
      H.vault = null;
      H.token = null;
      H.passkeys.records = [];
    }
  },
  readActiveProfileId: async () => H.activeProfileId,
  writeActiveProfileId: async (id: string) => {
    H.activeProfileId = id;
  },
  readVault: async (_profileId?: string) =>
    H.vault === null ? null : { ...H.vault, envelope: structuredClone(H.vault.envelope) },
  writeVault: async (_profileId: string, envelope: VaultEnvelope, syncedRevision: number | null) => {
    H.writes.push(structuredClone(envelope));
    H.vault = {
      envelope: structuredClone(envelope),
      syncedRevision,
      savedAt: new Date().toISOString(),
    };
  },
  updateSyncedRevision: async (_profileId: string, revision: number | null) => {
    if (H.vault !== null) H.vault = { ...H.vault, syncedRevision: revision };
  },
  deleteVault: async (_profileId?: string) => {
    H.deletions += 1;
    H.vault = null;
    H.token = null;
    H.passkeys.records = [];
  },
  readToken: async (_profileId?: string) => H.token,
  writeToken: async (_profileId: string, token: string) => {
    H.token = token;
  },
  deleteToken: async (_profileId?: string) => {
    H.token = null;
  },
  readSettings: async <T,>() => H.settings as T | null,
  writeSettings: async (value: unknown) => {
    H.settings = value;
  },
  readPasskeys: async (_profileId?: string) => structuredClone(H.passkeys.records),
  putPasskey: async (_profileId: string, record: { id: string; [key: string]: unknown }) => {
    H.passkeys.records = [...H.passkeys.records.filter((item) => item.id !== record.id), structuredClone(record)];
  },
  deletePasskey: async (id: string, _profileId?: string) => {
    H.passkeys.records = H.passkeys.records.filter((item) => item.id !== id);
  },
  replacePasskeys: async (_profileId: string, records: Array<{ id: string; [key: string]: unknown }>) => {
    H.passkeys.records = structuredClone(records);
  },
  deleteAllPasskeys: async (_profileId?: string) => {
    H.passkeys.records = [];
  },
}));

vi.mock('../../src/lib/passkeys', () => ({
  PasskeyCancelledError: H.passkeys.CancelledError,
  PasskeyPrfUnsupportedError: H.passkeys.PrfUnsupportedError,
  PasskeyUnavailableError: H.passkeys.UnavailableError,
  isPasskeyAvailable: () => H.passkeys.available,
  createPasskeyCredential: async (options: { prfSalt: Uint8Array }) => {
    const error = H.passkeys.createError;
    if (error !== null) {
      H.passkeys.createError = null;
      throw error;
    }
    H.passkeys.issued += 1;
    const credentialId = `credential-${H.passkeys.issued}`;
    const prfOutput = H.passkeys.outputOverride ?? (await H.passkeys.fakePrf(options.prfSalt));
    return { credentialId, prfOutput, transports: ['internal'] };
  },
  getPasskeyAssertion: async (candidates: Array<{ id: string; prfSalt: string }>) => {
    const error = H.passkeys.assertError;
    if (error !== null) {
      H.passkeys.assertError = null;
      throw error;
    }
    const chosen =
      H.passkeys.chosenId === null
        ? candidates[0]
        : candidates.find((candidate) => candidate.id === H.passkeys.chosenId) ?? candidates[0];
    if (chosen === undefined) throw new H.passkeys.UnavailableError();
    const prfOutput = H.passkeys.outputOverride ?? (await H.passkeys.fakePrf(H.passkeys.decodeBase64(chosen.prfSalt)));
    return { credentialId: chosen.id, prfOutput };
  },
}));

vi.mock('../../src/lib/syncClient', () => ({
  SyncHttpError: H.errors.SyncHttpError,
  SyncConflictError: H.errors.SyncConflictError,
  SyncNotFoundError: H.errors.SyncNotFoundError,
  createSyncClient: () => H.client,
}));

vi.mock('../../shared/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof CryptoModule>();
  type UpdateArgs = Parameters<typeof actual.updateEnvelopeData>;
  return {
    ...actual,
    updateEnvelopeData: async (...args: UpdateArgs) => {
      const gate = H.crypto.gate;
      if (gate !== null) {
        H.crypto.onEntry?.();
        H.crypto.onEntry = null;
        await gate;
      }
      return actual.updateEnvelopeData(...args);
    },
  };
});

const PASSWORD = 'correct horse battery staple';
const OTHER_PASSWORD = 'another very long password 42';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const SECOND_TOKEN = 'ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zyxwvut';
/** テストでは PBKDF2 の下限（100,000 回）を使う。 */
const TEST_ITERATIONS = 100_000;

type Modules = {
  vault: typeof VaultStoreModule;
  crypto: typeof CryptoModule;
};

async function loadModules(): Promise<Modules> {
  vi.resetModules();
  const vault = await import('../../src/lib/vaultStore');
  const crypto = await import('../../shared/crypto');
  return { vault, crypto };
}

function account(id: string, overrides: Partial<Account> = {}): Account {
  return {
    id,
    type: 'totp',
    issuer: 'Example',
    label: `${id}@example.com`,
    secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    counter: 0,
    pinned: false,
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

type FixtureOptions = {
  password?: string;
  accounts?: Account[];
  tombstones?: Tombstone[];
  revision?: number;
  dek?: Uint8Array;
  iterations?: number;
  token?: string | null;
  /** undefined なら envelope.revision（同期済み扱い） */
  syncedRevision?: number | null;
  plaintext?: string;
};

async function writeFixture(crypto: Modules['crypto'], options: FixtureOptions = {}): Promise<VaultEnvelope> {
  const envelope = await crypto.createVaultEnvelope({
    password: options.password ?? PASSWORD,
    plaintext:
      options.plaintext ??
      JSON.stringify({ accounts: options.accounts ?? [], tombstones: options.tombstones ?? [] }),
    revision: options.revision ?? 1,
    iterations: options.iterations ?? TEST_ITERATIONS,
    dek: options.dek,
  });
  H.vault = {
    envelope,
    syncedRevision:
      options.syncedRevision === undefined ? envelope.revision : options.syncedRevision,
    savedAt: '2026-01-01T00:00:00.000Z',
  };
  H.token = options.token ?? null;
  return envelope;
}

/** 保存済みボルトを初期化して解錠したストアを返す。 */
async function unlockedStore(options: FixtureOptions = {}) {
  const modules = await loadModules();
  await writeFixture(modules.crypto, options);
  // 同期テスト用: サーバーは最後に同期した revision の封筒を持っていることにする。
  if (options.token !== undefined && options.token !== null) {
    H.server.get = async () => {
      const stored = H.vault as { envelope: VaultEnvelope; syncedRevision: number | null };
      return { envelope: stored.envelope, revision: stored.syncedRevision ?? 0 };
    };
  }
  const store = modules.vault.useVaultStore;
  await store.getState().initialize();
  const result = await store.getState().unlock(options.password ?? PASSWORD);
  expect(result.ok).toBe(true);
  // 解錠直後に走る refreshRemote を先に片付けて、後続の同期テストと競合させない。
  await settle(10);
  return { ...modules, store, envelope: H.vault?.envelope as VaultEnvelope };
}

/** 暗号化（updateEnvelopeData）を任意の地点で止める。 */
function holdEncryption(): { release: () => void; entered: Promise<void> } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    H.crypto.onEntry = resolve;
  });
  H.crypto.gate = gate;
  return {
    entered,
    release: () => {
      H.crypto.gate = null;
      release();
    },
  };
}

/** 実イベントループで非同期処理（WebCrypto 等）の完了を待つ。 */
async function settle(ms = 25): Promise<void> {
  await new Promise<void>((resolve) => {
    realSetTimeout(() => resolve(), ms);
  });
}

async function decrypted(envelope: VaultEnvelope, crypto: Modules['crypto'], password = PASSWORD) {
  const unlocked = await crypto.unlockVaultEnvelope(envelope, password);
  return JSON.parse(unlocked.plaintext) as {
    accounts: Account[];
    tombstones: Tombstone[];
    devices?: SyncDevice[];
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
  H.vault = null;
  H.token = null;
  H.profiles = [];
  H.activeProfileId = 'main';
  H.settings = null;
  H.writes = [];
  H.deletions = 0;
  H.crypto.gate = null;
  H.crypto.onEntry = null;
  H.passkeys.records = [];
  H.passkeys.issued = 0;
  H.passkeys.outputOverride = null;
  H.passkeys.createError = null;
  H.passkeys.assertError = null;
  H.passkeys.chosenId = null;
  H.passkeys.available = true;
  H.server.get = async () => {
    throw new H.errors.SyncNotFoundError();
  };
  H.server.put = async (_vaultId: string, _token: string, envelope: VaultEnvelope) => ({
    revision: envelope.revision,
  });
  H.server.remove = async () => undefined;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ボルトストア: 基本ヘルパ', () => {
  it('makeAccountId は UUID v4 形式の id を重複なく返す', async () => {
    const { vault } = await loadModules();
    const first = vault.makeAccountId();
    const second = vault.makeAccountId();
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(second).not.toBe(first);
  });

  it('sortAccounts はピン留め → order → createdAt の順に並べる', async () => {
    const { vault } = await loadModules();
    const sorted = vault.sortAccounts([
      account('c', { order: 2, createdAt: '2026-01-03T00:00:00.000Z' }),
      account('b', { order: 1, createdAt: '2026-01-02T00:00:00.000Z' }),
      account('a', { order: 1, createdAt: '2026-01-01T00:00:00.000Z' }),
      account('p', { pinned: true, order: 99, createdAt: '2026-01-04T00:00:00.000Z' }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(['p', 'a', 'b', 'c']);
  });
});

describe('ボルトストア: initialize', () => {
  it('保存が無ければ未初期化として既定設定を読み込む', async () => {
    const { vault } = await loadModules();
    const store = vault.useVaultStore;
    await store.getState().initialize();
    const state = store.getState();
    expect(state.status).toBe('uninitialized');
    expect(state.envelope).toBeNull();
    expect(state.token).toBeNull();
    expect(state.vaultId).toBeNull();
    expect(state.settings.theme).toBe('system');
    expect(state.settings.autoLockMinutes).toBe(5);
  });

  it('保存済みボルトはロック状態で読み込み、vaultId をトークンから導出する', async () => {
    const modules = await loadModules();
    const { deriveVaultId } = await import('../../shared/sync');
    const envelope = await writeFixture(modules.crypto, {
      accounts: [account('a')],
      revision: 3,
      token: TOKEN,
    });
    const store = modules.vault.useVaultStore;
    await store.getState().initialize();
    const state = store.getState();
    expect(state.status).toBe('locked');
    expect(state.envelope?.revision).toBe(3);
    expect(state.token).toBe(TOKEN);
    expect(state.vaultId).toBe(await deriveVaultId(TOKEN));
    expect(state.syncedRevision).toBe(3);
    expect(state.syncState).toBe('synced');
    expect(state.accounts).toEqual([]);
    expect(envelope.revision).toBe(3);
  });

  it('未送信の revision があれば pending として復帰し、デバウンス後に送る', async () => {
    const modules = await loadModules();
    await writeFixture(modules.crypto, { revision: 4, token: TOKEN, syncedRevision: 3 });
    const put = vi.fn(async (_v: string, _t: string, envelope: VaultEnvelope, _base: number) => ({
      revision: envelope.revision,
    }));
    H.server.put = put;
    const store = modules.vault.useVaultStore;
    await store.getState().initialize();
    expect(store.getState().syncState).toBe('pending');
    expect(put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[3]).toBe(3);
    expect(store.getState().syncState).toBe('synced');
  });

  it('壊れた設定は既定値へ正規化する', async () => {
    const { vault } = await loadModules();
    H.settings = {
      theme: 'neon',
      autoLockMinutes: 42,
      clockSkew: 9,
      clearClipboard: false,
      lockOnHide: 'yes',
      announceCodes: false,
      language: 'fr',
    };
    const store = vault.useVaultStore;
    await store.getState().initialize();
    expect(store.getState().settings).toEqual({
      theme: 'system',
      autoLockMinutes: 5,
      lockOnHide: false,
      clockSkew: 2,
      clearClipboard: false,
      announceCodes: false,
      language: 'auto',
      sortMode: 'manual',
    });
  });
});

describe('ボルトストア: 作成', () => {
  it('短いパスワードでは作成せず、何も保存しない', async () => {
    const { vault } = await loadModules();
    const store = vault.useVaultStore;
    await store.getState().initialize();
    await expect(store.getState().createVault('short', { sync: false })).rejects.toThrow(
      'password_too_short',
    );
    expect(H.vault).toBeNull();
    expect(H.writes).toHaveLength(0);
    expect(store.getState().status).toBe('uninitialized');
  });

  it('同期ありで作成すると封筒とトークンを保存し、即時アップロードする', async () => {
    const { vault } = await loadModules();
    const store = vault.useVaultStore;
    await store.getState().initialize();
    const put = vi.fn(async (_v: string, _t: string, envelope: VaultEnvelope, _base: number) => ({
      revision: envelope.revision,
    }));
    H.server.put = put;
    const token = await store.getState().createVault(PASSWORD, { sync: true });
    await settle();
    expect(token).not.toBeNull();
    expect(H.token).toBe(token);
    expect(H.vault).not.toBeNull();
    expect(H.vault?.syncedRevision).toBe(1);
    expect(store.getState().status).toBe('unlocked');
    expect(store.getState().pendingSyncToken).toBe(token);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[3]).toBe(0);
    expect(store.getState().syncState).toBe('synced');
    expect(store.getState().syncedRevision).toBe(1);
  });

  it('ローカル専用で作成するとトークンも同期もしない', async () => {
    const { vault } = await loadModules();
    const store = vault.useVaultStore;
    await store.getState().initialize();
    const put = vi.fn(H.server.put);
    H.server.put = put;
    const token = await store.getState().createVault(PASSWORD, { sync: false });
    await settle();
    expect(token).toBeNull();
    expect(H.token).toBeNull();
    expect(H.vault?.syncedRevision).toBeNull();
    expect(store.getState().syncState).toBe('local-only');
    expect(put).not.toHaveBeenCalled();
  });

  it('acknowledgeSyncToken は一度だけ表示する同期コードを消す', async () => {
    const { vault } = await loadModules();
    const store = vault.useVaultStore;
    await store.getState().initialize();
    await store.getState().createVault(PASSWORD, { sync: true });
    expect(store.getState().pendingSyncToken).not.toBeNull();
    store.getState().acknowledgeSyncToken();
    expect(store.getState().pendingSyncToken).toBeNull();
  });
});

describe('ボルトストア: 解錠とロック', () => {
  it('正しいパスワードで解錠し、アカウントを並べ替えて保持する', async () => {
    const { store } = await unlockedStore({
      accounts: [account('b', { order: 1 }), account('a', { order: 0 })],
    });
    const state = store.getState();
    expect(state.status).toBe('unlocked');
    expect(state.dek).toBeInstanceOf(Uint8Array);
    expect(state.accounts.map((item) => item.id)).toEqual(['a', 'b']);
    expect(state.failedAttempts).toBe(0);
  });

  it('誤ったパスワードは失敗回数を数え、状態を解錠しない', async () => {
    const modules = await loadModules();
    await writeFixture(modules.crypto, { accounts: [account('a')] });
    const store = modules.vault.useVaultStore;
    await store.getState().initialize();
    const result = await store.getState().unlock('wrong password!!');
    expect(result.ok).toBe(false);
    expect(result.cooldownSeconds).toBeUndefined();
    expect(store.getState().failedAttempts).toBe(1);
    expect(store.getState().status).toBe('locked');
    expect(store.getState().accounts).toEqual([]);
  });

  it('5 回失敗すると 30 秒のクールダウンに入り、その間は試行しない', async () => {
    const modules = await loadModules();
    await writeFixture(modules.crypto, {});
    const store = modules.vault.useVaultStore;
    await store.getState().initialize();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await store.getState().unlock('nope')).ok).toBe(false);
    }
    const fifth = await store.getState().unlock('nope');
    expect(fifth).toEqual({ ok: false, cooldownSeconds: 30 });
    expect(store.getState().failedAttempts).toBe(0);
    expect(store.getState().cooldownUntil).toBe(Date.parse('2026-02-01T00:00:00.000Z') + 30_000);
    const during = await store.getState().unlock(PASSWORD);
    expect(during.ok).toBe(false);
    expect(during.cooldownSeconds).toBe(30);
    vi.setSystemTime(new Date('2026-02-01T00:00:31.000Z'));
    expect((await store.getState().unlock(PASSWORD)).ok).toBe(true);
  });

  it('ロックすると DEK と平文を捨て、封筒は残す', async () => {
    const { store } = await unlockedStore({ accounts: [account('a')] });
    store.getState().lock();
    const state = store.getState();
    expect(state.status).toBe('locked');
    expect(state.dek).toBeNull();
    expect(state.accounts).toEqual([]);
    expect(state.tombstones).toEqual([]);
    expect(state.envelope).not.toBeNull();
    expect(H.vault).not.toBeNull();
  });

  it('ロック中は保存要求を無視する（暗号文を書き換えない）', async () => {
    const modules = await loadModules();
    const envelope = await writeFixture(modules.crypto, { accounts: [account('a')] });
    const store = modules.vault.useVaultStore;
    await store.getState().initialize();
    await store.getState().saveAccounts([account('b')]);
    expect(H.writes).toHaveLength(0);
    expect(H.vault?.envelope.revision).toBe(envelope.revision);
  });

  it('壊れた平文の tombstones は id と deletedAt を持つ要素だけ残す', async () => {
    const modules = await loadModules();
    await writeFixture(modules.crypto, {
      plaintext: JSON.stringify({
        accounts: 'not-an-array',
        tombstones: [
          { id: 'ok', deletedAt: '2026-01-02T00:00:00.000Z' },
          { id: 'missing-time' },
          'garbage',
          null,
        ],
      }),
    });
    const store = modules.vault.useVaultStore;
    await store.getState().initialize();
    await store.getState().unlock(PASSWORD);
    expect(store.getState().accounts).toEqual([]);
    expect(store.getState().tombstones).toEqual([
      { id: 'ok', deletedAt: '2026-01-02T00:00:00.000Z' },
    ]);
  });
});

describe('ボルトストア: 保存の直列化と世代管理', () => {
  it('同時に走った追加は両方とも保存される（書き込みキュー）', async () => {
    const { store, crypto } = await unlockedStore({ accounts: [account('base')] });
    await Promise.all([
      store.getState().upsertAccount(account('one')),
      store.getState().upsertAccount(account('two')),
    ]);
    const persisted = await decrypted(H.vault!.envelope, crypto);
    expect(persisted.accounts.map((item) => item.id).sort()).toEqual(['base', 'one', 'two']);
    expect(H.vault?.envelope.revision).toBe(3);
    expect(store.getState().accounts).toHaveLength(3);
  });

  it('ふつうの削除はゴミ箱へ移し、tombstone はまだ作らない', async () => {
    const { store, crypto } = await unlockedStore({
      accounts: [account('keep'), account('drop')],
    });
    await store.getState().removeAccount('drop');
    const persisted = await decrypted(H.vault!.envelope, crypto);
    // 行は残る（復元できる）が、deletedAt が付いて通常の一覧から外れる。
    expect(persisted.accounts.map((item) => item.id)).toEqual(['keep', 'drop']);
    expect(persisted.accounts.find((item) => item.id === 'drop')?.deletedAt).toBe(
      '2026-02-01T00:00:00.000Z',
    );
    expect(persisted.tombstones).toHaveLength(0);
  });

  it('完全削除はアカウントを取り除き tombstone を残す', async () => {
    const { store, crypto } = await unlockedStore({
      accounts: [account('keep'), account('drop')],
    });
    await store.getState().purgeAccount('drop');
    const persisted = await decrypted(H.vault!.envelope, crypto);
    expect(persisted.accounts.map((item) => item.id)).toEqual(['keep']);
    expect(persisted.tombstones).toHaveLength(1);
    expect(persisted.tombstones[0]).toMatchObject({
      id: 'drop',
      deletedAt: '2026-02-01T00:00:00.000Z',
    });
  });

  it('並べ替えは order を更新し、変化の無い項目は触らない', async () => {
    const { store, crypto } = await unlockedStore({
      accounts: [account('a', { order: 0 }), account('b', { order: 1 }), account('c', { order: 2 })],
    });
    await store.getState().reorderAccounts(['a', 'c', 'b']);
    const persisted = await decrypted(H.vault!.envelope, crypto);
    const order = persisted.accounts.map((item) => [item.id, item.order]);
    expect(order).toEqual([
      ['a', 0],
      ['c', 1],
      ['b', 2],
    ]);
    expect(persisted.accounts.find((item) => item.id === 'c')?.updatedAt).toBe(
      '2026-02-01T00:00:00.000Z',
    );
    expect(persisted.accounts.find((item) => item.id === 'a')?.updatedAt).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('暗号化中に削除（wipe）されたら、その保存を確定しない', async () => {
    const { store } = await unlockedStore({ accounts: [account('a')] });
    const before = H.writes.length;
    const hold = holdEncryption();
    const saving = store.getState().upsertAccount(account('b'));
    await hold.entered;
    // wipe は世代を進めてから保存キューの完了を待つ（暗号化中の保存は確定しない）。
    const wiping = store.getState().wipe();
    await settle(5);
    hold.release();
    await saving;
    await wiping;
    expect(H.writes).toHaveLength(before);
    expect(H.vault).toBeNull();
    expect(H.deletions).toBe(1);
    expect(store.getState().status).toBe('uninitialized');
    expect(store.getState().envelope).toBeNull();
  });

  it('暗号化中にロックされたら封筒は保存するが、平文は戻さない', async () => {
    const { store, crypto } = await unlockedStore({ accounts: [account('a')] });
    const hold = holdEncryption();
    const saving = store.getState().upsertAccount(account('b'));
    await hold.entered;
    store.getState().lock();
    hold.release();
    await saving;
    expect(store.getState().status).toBe('locked');
    expect(store.getState().dek).toBeNull();
    expect(store.getState().accounts).toEqual([]);
    const persisted = await decrypted(H.vault!.envelope, crypto);
    expect(persisted.accounts.map((item) => item.id)).toEqual(['a', 'b']);
    expect(H.vault?.envelope.revision).toBe(2);
  });

  it('暗号化中にボルトが置き換わったら、古い保存を書き込まない', async () => {
    const { store, crypto } = await unlockedStore({ accounts: [account('a')] });
    const replacement = await crypto.createVaultEnvelope({
      password: OTHER_PASSWORD,
      plaintext: JSON.stringify({ accounts: [account('other')], tombstones: [] }),
      revision: 9,
      iterations: TEST_ITERATIONS,
    });
    const hold = holdEncryption();
    const saving = store.getState().upsertAccount(account('b'));
    await hold.entered;
    await store.getState().replaceVault(replacement, null);
    hold.release();
    await saving;
    expect(H.vault?.envelope.revision).toBe(9);
    expect(H.vault?.envelope.data.ciphertext).toBe(replacement.data.ciphertext);
    expect(store.getState().status).toBe('locked');
  });

  it('wipe はサーバー側の暗号文も削除する', async () => {
    const { store } = await unlockedStore({
      accounts: [account('a')],
      token: TOKEN,
      syncedRevision: 1,
    });
    const remove = vi.fn(async () => undefined);
    H.server.remove = remove;
    await store.getState().wipe();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(expect.any(String), TOKEN);
    expect(H.vault).toBeNull();
    expect(H.token).toBeNull();
    expect(store.getState().status).toBe('uninitialized');
  });

  it('wipe はデバウンス中の送信を取り消す（削除後に PUT が走らない）', async () => {
    const { store } = await unlockedStore({ accounts: [], token: TOKEN, syncedRevision: 1 });
    const put = vi.fn(H.server.put);
    H.server.put = put;
    await store.getState().upsertAccount(account('a'));
    await store.getState().wipe();
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(put).not.toHaveBeenCalled();
    expect(H.vault).toBeNull();
  });

  it('wipe は進行中の送信が終わってからサーバー削除を送る', async () => {
    const { store } = await unlockedStore({ accounts: [], token: TOKEN, syncedRevision: 1 });
    const order: string[] = [];
    let releasePut: () => void = () => undefined;
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    H.server.put = async (_v: string, _t: string, envelope: VaultEnvelope) => {
      order.push('put-start');
      await putGate;
      order.push('put-end');
      return { revision: envelope.revision };
    };
    H.server.remove = async () => {
      order.push('delete');
    };
    await store.getState().upsertAccount(account('a'));
    await vi.advanceTimersByTimeAsync(2000);
    await settle(5);
    const wiping = store.getState().wipe();
    await settle(5);
    releasePut();
    await wiping;
    await settle();
    expect(order).toEqual(['put-start', 'put-end', 'delete']);
    expect(H.vault).toBeNull();
  });

  it('wipe はサーバー削除が失敗してもローカルを消す', async () => {
    const { store } = await unlockedStore({
      accounts: [account('a')],
      token: TOKEN,
      syncedRevision: 1,
    });
    H.server.remove = async () => {
      throw new H.errors.SyncHttpError(503, null);
    };
    await store.getState().wipe();
    expect(H.vault).toBeNull();
    expect(store.getState().status).toBe('uninitialized');
  });

  it('wipe のサーバー削除を待つ間に接続された別のボルトは消さない', async () => {
    const { store, crypto } = await unlockedStore({
      accounts: [account('a')],
      token: TOKEN,
      syncedRevision: 1,
    });
    const remote = await crypto.createVaultEnvelope({
      password: PASSWORD,
      plaintext: JSON.stringify({ accounts: [account('b')], tombstones: [] }),
      revision: 3,
      iterations: TEST_ITERATIONS,
    });
    let releaseRemove: () => void = () => undefined;
    const removeGate = new Promise<void>((resolve) => {
      releaseRemove = resolve;
    });
    let removeStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      removeStarted = resolve;
    });
    H.server.remove = async () => {
      removeStarted();
      await removeGate;
    };
    H.server.get = async () => ({ envelope: remote, revision: 3 });
    const wiping = store.getState().wipe();
    await started;
    // サーバー削除の待機中に、別のボルトへ接続する。
    await store.getState().attachSync(SECOND_TOKEN);
    releaseRemove();
    await wiping;
    // 新しいボルトは置き換え後に消されていない。
    expect(store.getState().status).toBe('locked');
    expect(store.getState().envelope?.revision).toBe(3);
    expect(H.vault?.envelope.revision).toBe(3);
    expect(H.token).toBe(SECOND_TOKEN);
  });

  it('wipe 後の古いセッションからの操作では、消したボルトを復活させない', async () => {
    const { store } = await unlockedStore({ accounts: [account('a')] });
    await store.getState().wipe();
    await store.getState().upsertAccount(account('b'));
    expect(H.vault).toBeNull();
    expect(store.getState().accounts).toEqual([]);
    expect(store.getState().status).toBe('uninitialized');
  });
});

describe('ボルトストア: 同期', () => {
  it('保存後にデバウンスして送信し、同期済みになる', async () => {
    const { store } = await unlockedStore({ accounts: [], token: TOKEN, syncedRevision: 1 });
    const put = vi.fn(async (_v: string, _t: string, envelope: VaultEnvelope, _base: number) => ({
      revision: envelope.revision,
    }));
    H.server.put = put;
    await store.getState().upsertAccount(account('a'));
    expect(put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[3]).toBe(1);
    expect(store.getState().syncedRevision).toBe(2);
    expect(store.getState().syncState).toBe('synced');
    expect(store.getState().lastSyncedAt).not.toBeNull();
  });

  it('flushSync は保留中のデバウンスを即座に実行する', async () => {
    const { store } = await unlockedStore({ accounts: [], token: TOKEN, syncedRevision: 1 });
    const put = vi.fn(async (_v: string, _t: string, envelope: VaultEnvelope, _base: number) => ({
      revision: envelope.revision,
    }));
    H.server.put = put;
    await store.getState().upsertAccount(account('a'));
    store.getState().flushSync();
    await settle();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('サーバーが同じ封筒を持っていれば 409 を競合と誤認しない', async () => {
    const { store, crypto } = await unlockedStore({
      accounts: [account('a')],
      token: TOKEN,
      syncedRevision: 1,
    });
    await store.getState().upsertAccount(account('b'));
    const envelope = H.vault!.envelope;
    H.server.put = async () => {
      throw new H.errors.SyncConflictError(envelope.revision);
    };
    H.server.get = async () => ({ envelope, revision: envelope.revision });
    await store.getState().syncNow();
    await settle();
    expect(store.getState().syncState).toBe('synced');
    expect(store.getState().syncedRevision).toBe(2);
    expect(store.getState().conflict).toBeNull();
    // 再送した封筒は送信前のものと同一（サーバー側の内容を上書きしない）
    const stored = await decrypted(H.vault!.envelope, crypto);
    expect(stored.accounts).toHaveLength(2);
  });

  it('サーバーに別の編集があれば競合状態として提示する', async () => {
    const { store, crypto } = await unlockedStore({
      accounts: [account('a')],
      token: TOKEN,
      syncedRevision: 1,
    });
    const remote = await crypto.createVaultEnvelope({
      password: PASSWORD,
      plaintext: JSON.stringify({ accounts: [account('remote')], tombstones: [] }),
      revision: 5,
      iterations: TEST_ITERATIONS,
      dek: store.getState().dek as Uint8Array,
    });
    H.server.put = async () => {
      throw new H.errors.SyncConflictError(5);
    };
    H.server.get = async () => ({ envelope: remote, revision: 5 });
    await store.getState().upsertAccount(account('b'));
    await store.getState().syncNow();
    await settle();
    const state = store.getState();
    expect(state.syncState).toBe('conflict');
    expect(state.conflict).toEqual({ remoteRevision: 5, remoteEnvelope: remote });
  });

  it('サーバーに無ければ base 0 で再アップロードする', async () => {
    const { store } = await unlockedStore({ accounts: [], token: TOKEN, syncedRevision: null });
    const bases: number[] = [];
    let first = true;
    H.server.put = async (_v: string, _t: string, envelope: VaultEnvelope, base: number) => {
      bases.push(base);
      if (first) {
        first = false;
        throw new H.errors.SyncNotFoundError();
      }
      return { revision: envelope.revision };
    };
    await store.getState().upsertAccount(account('a'));
    await store.getState().syncNow();
    await settle();
    expect(bases).toEqual([0, 0]);
    expect(store.getState().syncState).toBe('synced');
  });

  it('再作成の送信中に編集されたら、続けて新しい revision を送る', async () => {
    const { store } = await unlockedStore({ accounts: [], token: TOKEN, syncedRevision: null });
    const bases: number[] = [];
    let releaseSecond: () => void = () => undefined;
    const secondPut = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let call = 0;
    H.server.put = async (_v: string, _t: string, envelope: VaultEnvelope, base: number) => {
      call += 1;
      bases.push(base);
      if (call === 1) throw new H.errors.SyncNotFoundError();
      if (call === 2) {
        await secondPut;
        return { revision: envelope.revision };
      }
      return { revision: envelope.revision };
    };
    // ローカルに未送信の変更がある状態から始める（封筒 revision 2 / base 0）。
    await store.getState().upsertAccount(account('a'));
    const syncing = store.getState().syncNow();
    await settle(10);
    // 再作成（base 0）の送信中にもう 1 件追加する。
    await store.getState().upsertAccount(account('b'));
    releaseSecond();
    await syncing;
    await settle();
    expect(store.getState().syncedRevision).toBe(2);
    expect(store.getState().syncState).toBe('pending');
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(bases).toEqual([0, 0, 2]);
    expect(store.getState().syncedRevision).toBe(3);
    expect(store.getState().syncState).toBe('synced');
  });

  it('HTTP エラーはステータス付きで記録する', async () => {
    const { store } = await unlockedStore({ accounts: [], token: TOKEN, syncedRevision: 1 });
    H.server.put = async () => {
      throw new H.errors.SyncHttpError(503, { error: 'unavailable' });
    };
    await store.getState().upsertAccount(account('a'));
    await store.getState().syncNow();
    await settle();
    expect(store.getState().syncState).toBe('error');
    expect(store.getState().syncError).toBe('http_503');
  });

  it('オフラインでは送信せず pending として残す', async () => {
    const { store } = await unlockedStore({ accounts: [], token: TOKEN, syncedRevision: 1 });
    const put = vi.fn(H.server.put);
    H.server.put = put;
    vi.stubGlobal('navigator', { onLine: false });
    await store.getState().syncNow();
    expect(put).not.toHaveBeenCalled();
    expect(store.getState().syncState).toBe('pending');
    expect(store.getState().syncError).toBe('offline');
  });

  it('送信中に編集されたら、続けて新しい revision を送る', async () => {
    const { store } = await unlockedStore({ accounts: [], token: TOKEN, syncedRevision: 1 });
    const bases: number[] = [];
    const sent: number[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstPut = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    H.server.put = async (_v: string, _t: string, envelope: VaultEnvelope, base: number) => {
      call += 1;
      bases.push(base);
      sent.push(envelope.revision);
      if (call === 1) {
        await firstPut;
        return { revision: envelope.revision };
      }
      return { revision: envelope.revision };
    };
    // 1 回目の編集はデバウンスで送られる（封筒 revision 2 / base 1）。
    await store.getState().upsertAccount(account('a'));
    await vi.advanceTimersByTimeAsync(2000);
    await settle(5);
    // 送信中にさらにもう 1 件追加する（封筒 revision 3）。
    await store.getState().upsertAccount(account('b'));
    releaseFirst();
    await settle();
    expect(store.getState().syncedRevision).toBe(2);
    expect(store.getState().syncState).toBe('pending');
    // 続けて revision 3 を base 2 で送る（サーバーの revision_must_advance を満たす）。
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(bases).toEqual([1, 2]);
    expect(sent).toEqual([2, 3]);
    expect(store.getState().syncedRevision).toBe(3);
    expect(store.getState().syncState).toBe('synced');
  });

  it('同期を解除するとトークンを消し、ローカル専用へ戻す', async () => {
    const { store } = await unlockedStore({
      accounts: [account('a')],
      token: TOKEN,
      syncedRevision: 1,
    });
    const remove = vi.fn(async () => undefined);
    H.server.remove = remove;
    await store.getState().disableSync();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(H.token).toBeNull();
    expect(store.getState().token).toBeNull();
    expect(store.getState().syncState).toBe('local-only');
    expect(store.getState().syncedRevision).toBeNull();
    expect(H.vault?.envelope).not.toBeNull();
    expect(H.vault?.syncedRevision).toBeNull();
  });

  it('サーバー削除が失敗してもローカル側の同期設定は解除する', async () => {
    const { store } = await unlockedStore({
      accounts: [account('a')],
      token: TOKEN,
      syncedRevision: 1,
    });
    H.server.remove = async () => {
      throw new H.errors.SyncHttpError(500, null);
    };
    await store.getState().disableSync();
    expect(H.token).toBeNull();
    expect(store.getState().syncState).toBe('local-only');
  });

  it('同期コードを接続すると、リモートの封筒でロック状態になる', async () => {
    const modules = await loadModules();
    const remote = await modules.crypto.createVaultEnvelope({
      password: PASSWORD,
      plaintext: JSON.stringify({ accounts: [account('remote')], tombstones: [] }),
      revision: 7,
      iterations: TEST_ITERATIONS,
    });
    H.server.get = async () => ({ envelope: remote, revision: 7 });
    const store = modules.vault.useVaultStore;
    await store.getState().initialize();
    await store.getState().attachSync(TOKEN);
    const state = store.getState();
    expect(state.status).toBe('locked');
    expect(state.envelope?.revision).toBe(7);
    expect(state.syncedRevision).toBe(7);
    expect(state.syncState).toBe('synced');
    expect(H.token).toBe(TOKEN);
    expect(H.vault?.envelope.revision).toBe(7);
  });

  it('接続中に別のボルトへ切り替わっていたら VaultChangedError', async () => {
    const modules = await loadModules();
    const remote = await modules.crypto.createVaultEnvelope({
      password: PASSWORD,
      plaintext: JSON.stringify({ accounts: [], tombstones: [] }),
      revision: 2,
      iterations: TEST_ITERATIONS,
    });
    let releaseFetch: () => void = () => undefined;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    H.server.get = async () => {
      await fetchGate;
      return { envelope: remote, revision: 2 };
    };
    const store = modules.vault.useVaultStore;
    await store.getState().initialize();
    const attaching = store.getState().attachSync(TOKEN);
    await settle(5);
    await store.getState().wipe();
    releaseFetch();
    await expect(attaching).rejects.toBeInstanceOf(modules.vault.VaultChangedError);
    expect(H.token).toBeNull();
  });
});

describe('ボルトストア: 競合解決', () => {
  it('discard はリモートの封筒を採用して復号し直す', async () => {
    const { store, crypto } = await unlockedStore({
      accounts: [account('local')],
      token: TOKEN,
      syncedRevision: 1,
    });
    const remote = await crypto.createVaultEnvelope({
      password: PASSWORD,
      plaintext: JSON.stringify({ accounts: [account('remote')], tombstones: [] }),
      revision: 4,
      iterations: TEST_ITERATIONS,
      dek: store.getState().dek as Uint8Array,
    });
    store.setState({ conflict: { remoteRevision: 4, remoteEnvelope: remote }, syncState: 'conflict' });
    const result = await store.getState().resolveConflict('discard');
    await settle();
    expect(result.resolved).toBe(true);
    expect(store.getState().conflict).toBeNull();
    expect(store.getState().accounts.map((item) => item.id)).toEqual(['remote']);
    expect(store.getState().syncedRevision).toBe(4);
    expect(H.vault?.envelope.revision).toBe(4);
  });

  it('overwrite はリモート revision + 1 でローカルを送り直す', async () => {
    const { store, crypto } = await unlockedStore({
      accounts: [account('local')],
      token: TOKEN,
      syncedRevision: 1,
    });
    const remote = await crypto.createVaultEnvelope({
      password: PASSWORD,
      plaintext: JSON.stringify({ accounts: [account('remote')], tombstones: [] }),
      revision: 4,
      iterations: TEST_ITERATIONS,
      dek: store.getState().dek as Uint8Array,
    });
    const put = vi.fn(async (_v: string, _t: string, envelope: VaultEnvelope, _base: number) => ({
      revision: envelope.revision,
    }));
    H.server.put = put;
    store.setState({ conflict: { remoteRevision: 4, remoteEnvelope: remote }, syncState: 'conflict' });
    const result = await store.getState().resolveConflict('overwrite');
    await settle();
    expect(result).toEqual({ added: 0, updated: 0, resolved: true });
    expect(H.vault?.envelope.revision).toBe(5);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[3]).toBe(4);
    expect(store.getState().syncedRevision).toBe(5);
    expect(store.getState().syncState).toBe('synced');
  });

  it('merge は両端末のアカウントを統合し、削除済みは復活させない', async () => {
    const { store, crypto } = await unlockedStore({
      accounts: [account('keep'), account('deleted-locally')],
      tombstones: [{ id: 'deleted-remotely', deletedAt: '2026-01-02T00:00:00.000Z' }],
      token: TOKEN,
      syncedRevision: 1,
    });
    const remote = await crypto.createVaultEnvelope({
      password: PASSWORD,
      plaintext: JSON.stringify({
        accounts: [
          account('keep', {
            label: 'remote-newer@example.com',
            updatedAt: '2026-01-05T00:00:00.000Z',
          }),
          account('remote-only'),
          account('deleted-remotely', { updatedAt: '2026-01-01T00:00:00.000Z' }),
          account('deleted-locally', { updatedAt: '2026-01-01T00:00:00.000Z' }),
        ],
        tombstones: [{ id: 'deleted-locally', deletedAt: '2026-01-03T00:00:00.000Z' }],
      }),
      revision: 4,
      iterations: TEST_ITERATIONS,
      dek: store.getState().dek as Uint8Array,
    });
    H.server.put = async (_v: string, _t: string, envelope: VaultEnvelope) => ({
      revision: envelope.revision,
    });
    store.setState({ conflict: { remoteRevision: 4, remoteEnvelope: remote }, syncState: 'conflict' });
    const result = await store.getState().resolveConflict('merge');
    await settle();
    expect(result.resolved).toBe(true);
    expect(result.added).toBe(1);
    expect(result.updated).toBe(1);
    const ids = store.getState().accounts.map((item) => item.id).sort();
    expect(ids).toEqual(['keep', 'remote-only']);
    expect(store.getState().accounts.find((item) => item.id === 'keep')?.label).toBe(
      'remote-newer@example.com',
    );
    const persisted = await decrypted(H.vault!.envelope, crypto);
    expect(persisted.tombstones.map((item) => item.id).sort()).toEqual([
      'deleted-locally',
      'deleted-remotely',
    ]);
  });

  it('別の DEK のリモートとはマージせず、ロックへ戻す', async () => {
    const { store } = await unlockedStore({ accounts: [account('local')], token: TOKEN, syncedRevision: 1 });
    const remote = await (await import('../../shared/crypto')).createVaultEnvelope({
      password: OTHER_PASSWORD,
      plaintext: JSON.stringify({ accounts: [account('remote')], tombstones: [] }),
      revision: 3,
      iterations: TEST_ITERATIONS,
    });
    store.setState({ conflict: { remoteRevision: 3, remoteEnvelope: remote }, syncState: 'conflict' });
    const result = await store.getState().resolveConflict('merge');
    await settle();
    expect(result.resolved).toBe(false);
    expect(store.getState().status).toBe('locked');
    expect(store.getState().dek).toBeNull();
    expect(store.getState().accounts).toEqual([]);
    expect(store.getState().conflict).toBeNull();
  });

  it('競合が無ければ何もしない', async () => {
    const { store } = await unlockedStore({ accounts: [account('a')], token: TOKEN });
    const result = await store.getState().resolveConflict('merge');
    expect(result).toEqual({ added: 0, updated: 0, resolved: false });
  });
});

describe('ボルトストア: バックアップの取り込み', () => {
  it('replace はパスワード無し・誤りでは置き換えない', async () => {
    const { store, crypto } = await unlockedStore({ accounts: [account('current')] });
    const backup = await crypto.createVaultEnvelope({
      password: OTHER_PASSWORD,
      plaintext: JSON.stringify({ accounts: [account('backup')], tombstones: [] }),
      revision: 2,
      iterations: TEST_ITERATIONS,
    });
    const before = H.vault!.envelope.revision;
    await expect(store.getState().importEnvelope(backup, 'replace')).rejects.toBeInstanceOf(
      crypto.WrongPasswordError,
    );
    await expect(store.getState().importEnvelope(backup, 'replace', 'wrong')).rejects.toBeInstanceOf(
      crypto.WrongPasswordError,
    );
    expect(H.vault?.envelope.revision).toBe(before);
  });

  it('replace は検証済みのバックアップでボルトを差し替える', async () => {
    const { store, crypto } = await unlockedStore({ accounts: [account('current')] });
    const backup = await crypto.createVaultEnvelope({
      password: OTHER_PASSWORD,
      plaintext: JSON.stringify({ accounts: [account('backup')], tombstones: [] }),
      revision: 2,
      iterations: TEST_ITERATIONS,
    });
    const count = await store.getState().importEnvelope(backup, 'replace', OTHER_PASSWORD);
    expect(count).toBe(0);
    expect(H.vault?.envelope.data.ciphertext).toBe(backup.data.ciphertext);
    expect(H.vault?.syncedRevision).toBeNull();
    expect(store.getState().status).toBe('locked');
    expect(store.getState().envelope?.revision).toBe(2);
  });

  it('merge は別パスワードのバックアップを現在の DEK で統合する', async () => {
    const { store, crypto } = await unlockedStore({ accounts: [account('current')] });
    const backup = await crypto.createVaultEnvelope({
      password: OTHER_PASSWORD,
      plaintext: JSON.stringify({ accounts: [account('backup')], tombstones: [] }),
      revision: 1,
      iterations: TEST_ITERATIONS,
    });
    const merged = await store.getState().importEnvelope(backup, 'merge', OTHER_PASSWORD);
    expect(merged).toBe(1);
    const persisted = await decrypted(H.vault!.envelope, crypto);
    expect(persisted.accounts.map((item) => item.id).sort()).toEqual(['backup', 'current']);
    expect(store.getState().status).toBe('unlocked');
  });

  it('ロック中は merge を取り込まない', async () => {
    const { store, crypto, vault } = await unlockedStore({ accounts: [account('current')] });
    const backup = await crypto.createVaultEnvelope({
      password: OTHER_PASSWORD,
      plaintext: JSON.stringify({ accounts: [account('backup')], tombstones: [] }),
      revision: 1,
      iterations: TEST_ITERATIONS,
    });
    store.getState().lock();
    await expect(
      store.getState().importEnvelope(backup, 'merge', OTHER_PASSWORD),
    ).rejects.toBeInstanceOf(vault.VaultLockedError);
    expect(H.vault?.envelope.revision).toBe(1);
  });
});

describe('ボルトストア: パスワード変更と設定', () => {
  it('短すぎる新しいパスワードでは変更しない', async () => {
    const { store } = await unlockedStore({ accounts: [account('a')] });
    expect(await store.getState().changePassword(PASSWORD, 'short')).toBe(false);
    expect(store.getState().status).toBe('unlocked');
    expect(store.getState().failedAttempts).toBe(0);
  });

  it('現在のパスワードが違えば変更しない', async () => {
    const { store } = await unlockedStore({ accounts: [account('a')] });
    expect(await store.getState().changePassword('wrong', OTHER_PASSWORD)).toBe(false);
    expect(store.getState().status).toBe('unlocked');
  });

  it('変更後は新しいパスワードでのみ解錠できる', async () => {
    const { store } = await unlockedStore({ accounts: [account('a')] });
    expect(await store.getState().changePassword(PASSWORD, OTHER_PASSWORD)).toBe(true);
    await settle();
    store.getState().lock();
    expect((await store.getState().unlock(PASSWORD)).ok).toBe(false);
    store.setState({ failedAttempts: 0 });
    expect((await store.getState().unlock(OTHER_PASSWORD)).ok).toBe(true);
    expect(store.getState().accounts).toHaveLength(1);
  });

  it('設定はストアと永続層の両方へ書き込む', async () => {
    const { store } = await unlockedStore({});
    await store.getState().updateSettings({ theme: 'dark', autoLockMinutes: 1 });
    expect(store.getState().settings.theme).toBe('dark');
    expect(store.getState().settings.autoLockMinutes).toBe(1);
    expect(H.settings).toMatchObject({ theme: 'dark', autoLockMinutes: 1 });
  });
});

describe('ボルトストア: パスキー / セキュリティキー', () => {
  /** 別ボルトの登録などを直接仕込むための最小レコード。 */
  function storedPasskey(overrides: Partial<PasskeyRecord> = {}): PasskeyRecord {
    return {
      v: 1,
      id: 'credential-external',
      name: '古いキー',
      createdAt: '2026-01-01T00:00:00.000Z',
      prfSalt: bytesToBase64(new Uint8Array(32).fill(5)),
      wrappedDek: { iv: bytesToBase64(new Uint8Array(12).fill(6)), ciphertext: 'd3JhcHBlZA==' },
      vaultFingerprint: 'old-fingerprint',
      verifier: 'other-verifier',
      transports: ['internal'],
      ...overrides,
    };
  }

  it('登録すると封筒の verifier と指紋を保存し、一覧に入る', async () => {
    const { store, envelope } = await unlockedStore();
    const result = await store.getState().registerPasskey('Pixel の指紋');
    expect(result.ok).toBe(true);
    expect(store.getState().passkeys).toHaveLength(1);
    const record = store.getState().passkeys[0] as PasskeyRecord;
    expect(record.name).toBe('Pixel の指紋');
    expect(record.verifier).toBe(envelope.verifier);
    expect(record.vaultFingerprint).toBe(envelopeFingerprint(envelope));
    expect(record.transports).toEqual(['internal']);
    expect(record.wrappedDek.ciphertext).not.toBe('');
    // 端末の保存層にも書かれている（サーバーへは送らない）。
    expect(H.passkeys.records).toHaveLength(1);
  });

  it('表示名が空なら既定名で登録する', async () => {
    const { store } = await unlockedStore();
    await store.getState().registerPasskey('   ');
    expect(store.getState().passkeys[0]?.name).toBe('パスキー');
  });

  it('複数登録でき、2 つ目以降は同じ PRF salt を共有する', async () => {
    const { store } = await unlockedStore();
    await store.getState().registerPasskey('Pixel');
    await store.getState().registerPasskey('YubiKey');
    const [first, second] = store.getState().passkeys;
    expect(store.getState().passkeys).toHaveLength(2);
    expect(first?.id).not.toBe(second?.id);
    // 1 回の get でどの認証器を選んでも同じ KEK になるよう、salt は共通にする。
    expect(first?.prfSalt).toBe(second?.prfSalt);
  });

  it('登録したパスキーでロック中でも解除できる', async () => {
    const { store } = await unlockedStore({ accounts: [account('a')] });
    await store.getState().registerPasskey('Pixel');
    store.getState().lock();
    expect(store.getState().status).toBe('locked');
    // ロック中も解除ボタンを出せるよう、登録は状態に残す。
    expect(store.getState().passkeys).toHaveLength(1);

    const result = await store.getState().unlockWithPasskey();
    expect(result).toEqual({ ok: true });
    expect(store.getState().status).toBe('unlocked');
    expect(store.getState().accounts).toHaveLength(1);
    expect(H.vault?.envelope.revision).toBe(1);
  });

  it('2 つ目のパスキーを選んでも解除できる', async () => {
    const { store } = await unlockedStore();
    await store.getState().registerPasskey('Pixel');
    await store.getState().registerPasskey('YubiKey');
    const second = store.getState().passkeys[1] as PasskeyRecord;
    H.passkeys.chosenId = second.id;
    store.getState().lock();
    expect(await store.getState().unlockWithPasskey()).toEqual({ ok: true });
  });

  it('パスキーを削除すると一覧からも保存層からも消える', async () => {
    const { store } = await unlockedStore();
    await store.getState().registerPasskey('Pixel');
    const record = store.getState().passkeys[0] as PasskeyRecord;
    await store.getState().removePasskey(record.id);
    expect(store.getState().passkeys).toEqual([]);
    expect(H.passkeys.records).toEqual([]);
  });

  it('PRF 非対応の認証器では登録せず、理由を返す', async () => {
    const { store } = await unlockedStore();
    H.passkeys.createError = new H.passkeys.PrfUnsupportedError();
    const result = await store.getState().registerPasskey('古いキー');
    expect(result).toEqual({ ok: false, reason: 'prf_unsupported' });
    expect(store.getState().passkeys).toEqual([]);
    expect(H.passkeys.records).toEqual([]);
  });

  it('利用者がキャンセルしたら cancelled を返し、登録しない', async () => {
    const { store } = await unlockedStore();
    H.passkeys.createError = new H.passkeys.CancelledError();
    const result = await store.getState().registerPasskey('Pixel');
    expect(result).toEqual({ ok: false, reason: 'cancelled' });
    expect(H.passkeys.records).toEqual([]);
  });

  it('WebAuthn を使えない環境では unavailable を返す', async () => {
    const { store } = await unlockedStore();
    H.passkeys.available = false;
    expect(await store.getState().registerPasskey('Pixel')).toEqual({ ok: false, reason: 'unavailable' });
    expect(await store.getState().unlockWithPasskey()).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('ロック中に解除をキャンセルされたら cancelled を返し、ロックのまま', async () => {
    const { store } = await unlockedStore();
    await store.getState().registerPasskey('Pixel');
    store.getState().lock();
    H.passkeys.assertError = new H.passkeys.CancelledError();
    expect(await store.getState().unlockWithPasskey()).toEqual({ ok: false, reason: 'cancelled' });
    expect(store.getState().status).toBe('locked');
    expect(store.getState().dek).toBeNull();
  });

  it('PRF 出力が食い違えば解除せず、理由を返す（状態はロックのまま）', async () => {
    const { store } = await unlockedStore({ accounts: [account('a')] });
    await store.getState().registerPasskey('Pixel');
    store.getState().lock();
    // 登録時とは違う PRF 出力（別の認証器・別のボルト相当）。
    H.passkeys.outputOverride = new Uint8Array(32).fill(0xab);
    expect(await store.getState().unlockWithPasskey()).toEqual({ ok: false, reason: 'mismatch' });
    expect(store.getState().status).toBe('locked');
    expect(store.getState().dek).toBeNull();
  });

  it('登録が無ければ解除できない（no_passkeys）', async () => {
    const { store } = await unlockedStore();
    store.getState().lock();
    expect(await store.getState().unlockWithPasskey()).toEqual({ ok: false, reason: 'no_passkeys' });
  });

  it('別ボルトの登録は初期化時に捨てる（封筒の verifier で紐づけ）', async () => {
    const modules = await loadModules();
    const envelope = await writeFixture(modules.crypto);
    H.passkeys.records = [
      storedPasskey({ id: 'stale', verifier: 'other-verifier' }),
      storedPasskey({ id: 'mine', verifier: envelope.verifier }),
    ];
    const store = modules.vault.useVaultStore;
    await store.getState().initialize();
    expect(store.getState().passkeys.map((record) => record.id)).toEqual(['mine']);
    expect(H.passkeys.records.map((record) => record.id)).toEqual(['mine']);
  });

  it('パスワード変更後も同じパスキーで解除でき、保存の指紋が付け替わる', async () => {
    const { store } = await unlockedStore();
    await store.getState().registerPasskey('Pixel');
    const before = store.getState().passkeys[0] as PasskeyRecord;

    expect(await store.getState().changePassword(PASSWORD, OTHER_PASSWORD)).toBe(true);
    await settle(10);
    const updated = H.vault?.envelope as VaultEnvelope;
    const after = store.getState().passkeys[0] as PasskeyRecord;
    expect(store.getState().passkeys).toHaveLength(1);
    // DEK は変わらないので解除に使える。指紋だけ新しい封筒へ付け替える。
    expect(after.vaultFingerprint).toBe(envelopeFingerprint(updated));
    expect(after.vaultFingerprint).not.toBe(before.vaultFingerprint);

    store.getState().lock();
    expect(await store.getState().unlockWithPasskey()).toEqual({ ok: true });
    expect(store.getState().status).toBe('unlocked');
  });

  it('自動ロック「なし」なら、パスキーで解除した DEK をセッション継続用に預ける', async () => {
    const { store } = await unlockedStore({ accounts: [account('a')] });
    await store.getState().updateSettings({ autoLockMinutes: 0 });
    await store.getState().registerPasskey('Pixel');
    // sessionStorage はこのテスト環境（node）には無いので、保存先だけ差し替える。
    const items = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    });
    store.getState().lock();
    expect(items.size).toBe(0);
    expect(await store.getState().unlockWithPasskey()).toEqual({ ok: true });
    // マスターパスワードは保存せず、DEK と封筒の指紋だけを預ける。
    const stored = items.get('aegis.session.dek.v1') ?? '';
    expect(stored).not.toBe('');
    expect(stored).not.toContain(PASSWORD);
    expect(JSON.parse(stored)).toMatchObject({ v: 1 });
  });

  it('ボルトを消すと登録も消える', async () => {
    const { store } = await unlockedStore();
    await store.getState().registerPasskey('Pixel');
    await store.getState().wipe();
    expect(store.getState().passkeys).toEqual([]);
    expect(H.passkeys.records).toEqual([]);
  });

  it('別ボルトのバックアップで置き換えると、旧ボルトの登録を残さない', async () => {
    const { store, crypto } = await unlockedStore();
    await store.getState().registerPasskey('Pixel');
    const other = await crypto.createVaultEnvelope({
      password: OTHER_PASSWORD,
      plaintext: JSON.stringify({ accounts: [], tombstones: [] }),
      iterations: TEST_ITERATIONS,
    });
    await store.getState().importEnvelope(other, 'replace', OTHER_PASSWORD);
    expect(store.getState().passkeys).toEqual([]);
    expect(H.passkeys.records).toEqual([]);
  });

  it('同じボルトのバックアップ（同じ DEK）なら登録は残る', async () => {
    const { store, envelope, crypto } = await unlockedStore();
    await store.getState().registerPasskey('Pixel');
    const backup = await crypto.createVaultEnvelope({
      password: PASSWORD,
      dek: (store.getState().dek as Uint8Array),
      plaintext: JSON.stringify({ accounts: [], tombstones: [] }),
      revision: envelope.revision,
      iterations: TEST_ITERATIONS,
      salt: undefined,
    });
    await store.getState().importEnvelope(backup, 'replace', PASSWORD);
    expect(store.getState().passkeys.map((record) => record.name)).toEqual(['Pixel']);
  });
});

describe('ボルトストア: ゴミ箱・使用回数・同期端末', () => {
  it('ゴミ箱へ移したアカウントは復元できる', async () => {
    const { store, crypto } = await unlockedStore({ accounts: [account('a')] });
    await store.getState().removeAccount('a');
    expect(store.getState().accounts[0]?.deletedAt).toBe('2026-02-01T00:00:00.000Z');

    await store.getState().restoreAccount('a');
    const persisted = await decrypted(H.vault!.envelope, crypto);
    expect(persisted.accounts[0]?.deletedAt).toBeUndefined();
  });

  it('30 日を過ぎたゴミ箱は解錠時に完全削除される', async () => {
    const deletedAt = '2025-12-01T00:00:00.000Z';
    const { store, crypto } = await unlockedStore({
      accounts: [account('keep'), account('old', { deletedAt, updatedAt: deletedAt })],
    });
    await settle(30);
    const persisted = await decrypted(H.vault!.envelope, crypto);
    expect(persisted.accounts.map((item) => item.id)).toEqual(['keep']);
    expect(persisted.tombstones).toEqual([{ id: 'old', deletedAt }]);
    expect(store.getState().accounts.map((item) => item.id)).toEqual(['keep']);
  });

  it('ゴミ箱を空にすると全部 tombstone になり、復活しない', async () => {
    const { store, crypto } = await unlockedStore({
      accounts: [
        account('keep'),
        account('t1', { deletedAt: '2026-01-20T00:00:00.000Z' }),
        account('t2', { deletedAt: '2026-01-21T00:00:00.000Z' }),
      ],
    });
    await store.getState().emptyTrash();
    const persisted = await decrypted(H.vault!.envelope, crypto);
    expect(persisted.accounts.map((item) => item.id)).toEqual(['keep']);
    expect(persisted.tombstones.map((item) => item.id).sort()).toEqual(['t1', 't2']);
  });

  it('使用回数を記録するが updatedAt は変えない（同期を騒がせない）', async () => {
    const { store, crypto } = await unlockedStore({ accounts: [account('a')] });
    await store.getState().recordUsage('a');
    await store.getState().recordUsage('a');
    const persisted = await decrypted(H.vault!.envelope, crypto);
    expect(persisted.accounts[0]?.useCount).toBe(2);
    expect(persisted.accounts[0]?.lastUsedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(persisted.accounts[0]?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('端末名の変更と、端末一覧からの削除ができる', async () => {
    const { store, crypto } = await unlockedStore({ accounts: [] });
    await store.getState().renameDevice('My phone');
    expect(store.getState().deviceName).toBe('My phone');
    const afterRename = await decrypted(H.vault!.envelope, crypto);
    expect(afterRename.devices?.some((device) => device.name === 'My phone')).toBe(true);

    const self = store.getState().deviceId;
    // 自端末は消せない代わりに、他の端末の記録は消せる。
    await store.getState().forgetDevice('other-device');
    expect(store.getState().devices.some((device) => device.id === 'other-device')).toBe(false);
    expect(store.getState().devices.some((device) => device.id === self)).toBe(true);
  });
});

describe('ボルトストア: アプリでログイン', () => {
  it('未同期のボルトは同期コードを自動発行し、初回同期してから DEK を返す', async () => {
    const { store } = await unlockedStore({ accounts: [account('a')], token: null });
    const put = vi.fn(async (_v: string, _t: string, envelope: VaultEnvelope, _base: number) => ({
      revision: envelope.revision,
    }));
    H.server.put = put;

    const result = await store.getState().prepareAppLogin();

    // 同期コードは base64url の 32 バイトで、ストアと保存先の両方に入る。
    expect(isValidSyncToken(result.token)).toBe(true);
    expect(H.token).toBe(result.token);
    expect(store.getState().token).toBe(result.token);
    // サーバーへは base 0（新規作成）で 1 回だけ送る。
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[3]).toBe(0);
    expect(store.getState().syncState).toBe('synced');
    expect(store.getState().syncedRevision).toBe(H.vault?.envelope.revision);
    // 渡す DEK はアンロック中のもの。ボルト名はプロファイル名。
    expect(result.dek).toEqual(store.getState().dek);
    expect(result.vaultName).toBe('メイン');
  });

  it('同期済みのボルトは既存の同期コードをそのまま返し、追加の送信をしない', async () => {
    const { store } = await unlockedStore({ accounts: [], token: TOKEN, syncedRevision: 1 });
    const put = vi.fn(async (_v: string, _t: string, envelope: VaultEnvelope, _base: number) => ({
      revision: envelope.revision,
    }));
    H.server.put = put;

    const result = await store.getState().prepareAppLogin();

    expect(result.token).toBe(TOKEN);
    expect(H.token).toBe(TOKEN);
    expect(put).not.toHaveBeenCalled();
  });

  it('コードはあるが未送信なら、渡す前に送っておく', async () => {
    const { store } = await unlockedStore({ accounts: [], token: TOKEN, syncedRevision: null });
    const put = vi.fn(async (_v: string, _t: string, envelope: VaultEnvelope, _base: number) => ({
      revision: envelope.revision,
    }));
    H.server.put = put;

    const result = await store.getState().prepareAppLogin();

    expect(result.token).toBe(TOKEN);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[3]).toBe(0);
    expect(store.getState().syncedRevision).not.toBeNull();
  });

  it('初回同期に失敗したら AppLoginSyncError を投げる（アプリへは渡さない）', async () => {
    const { vault, store } = await unlockedStore({ accounts: [], token: null });
    H.server.put = async () => {
      throw new H.errors.SyncHttpError(503, null);
    };

    await expect(store.getState().prepareAppLogin()).rejects.toBeInstanceOf(vault.AppLoginSyncError);
    expect(store.getState().syncState).toBe('error');
  });

  it('ロック中は VaultLockedError を投げる', async () => {
    const { vault, store } = await unlockedStore({ accounts: [] });
    store.getState().lock();
    await expect(store.getState().prepareAppLogin()).rejects.toBeInstanceOf(vault.VaultLockedError);
  });
});
