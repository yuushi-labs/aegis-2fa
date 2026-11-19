/**
 * ボルトストア（クライアント状態 + 永続化 + 同期）の単体テスト。
 *
 * IndexedDB（./storage）と同期 API（./syncClient）はメモリ実装に差し替え、
 * 暗号処理は本物を使う（shared/crypto）。暗号化だけは任意のタイミングで
 * 止められるようラップし、保存中にロック・削除・置換が起きた場合の競合を再現する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Tombstone, VaultEnvelope } from '../../shared/types';
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

  type StoredVault = { envelope: VaultEnvelope; syncedRevision: number | null; savedAt: string };
  type Remote = { envelope: VaultEnvelope; revision: number };

  const harness = {
    vault: null as StoredVault | null,
    token: null as string | null,
    settings: null as unknown,
    writes: [] as VaultEnvelope[],
    deletions: 0,
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
  DB_VERSION: 1,
  resetStorageCache: () => undefined,
  readVault: async () => (H.vault === null ? null : { ...H.vault, envelope: structuredClone(H.vault.envelope) }),
  writeVault: async (envelope: VaultEnvelope, syncedRevision: number | null) => {
    H.writes.push(structuredClone(envelope));
    H.vault = {
      envelope: structuredClone(envelope),
      syncedRevision,
      savedAt: new Date().toISOString(),
    };
  },
  updateSyncedRevision: async (revision: number | null) => {
    if (H.vault !== null) H.vault = { ...H.vault, syncedRevision: revision };
  },
  deleteVault: async () => {
    H.deletions += 1;
    H.vault = null;
    H.token = null;
  },
  readToken: async () => H.token,
  writeToken: async (token: string) => {
    H.token = token;
  },
  deleteToken: async () => {
    H.token = null;
  },
  readSettings: async <T,>() => H.settings as T | null,
  writeSettings: async (value: unknown) => {
    H.settings = value;
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
  return JSON.parse(unlocked.plaintext) as { accounts: Account[]; tombstones: Tombstone[] };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
  H.vault = null;
  H.token = null;
  H.settings = null;
  H.writes = [];
  H.deletions = 0;
  H.crypto.gate = null;
  H.crypto.onEntry = null;
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

  it('削除はアカウントを取り除き tombstone を残す', async () => {
    const { store, crypto } = await unlockedStore({
      accounts: [account('keep'), account('drop')],
    });
    await store.getState().removeAccount('drop');
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
    await store.getState().wipe();
    hold.release();
    await saving;
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
