import { describe, expect, it } from 'vitest';
import {
  accountFingerprint,
  findDuplicates,
  mergeDevices,
  mergeTombstones,
  mergeVaultData,
} from '../../shared/merge';
import type { Account, VaultData } from '../../shared/types';

function makeAccount(overrides: Partial<Account> & { id: string }): Account {
  return {
    type: 'totp',
    issuer: 'Example',
    label: `${overrides.id}@example.com`,
    secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    counter: 0,
    pinned: false,
    order: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('同期マージ', () => {
  it('id 単位の union で、同一 id は updatedAt が新しい方', () => {
    const base: VaultData = {
      accounts: [
        makeAccount({ id: 'a', label: 'old', updatedAt: '2024-01-01T00:00:00.000Z' }),
        makeAccount({ id: 'b' }),
      ],
    };
    const incoming: VaultData = {
      accounts: [
        makeAccount({ id: 'a', label: 'new', updatedAt: '2024-02-01T00:00:00.000Z' }),
        makeAccount({ id: 'c' }),
      ],
    };
    const result = mergeVaultData(base, incoming);
    expect(result.data.accounts).toHaveLength(3);
    expect(result.data.accounts.find((a) => a.id === 'a')?.label).toBe('new');
    expect(result.added).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.overwritten).toBe(0);
  });

  it('古い側で上書きしようとしても新しい方を保つ', () => {
    const base: VaultData = {
      accounts: [makeAccount({ id: 'a', label: 'newer', updatedAt: '2024-03-01T00:00:00.000Z' })],
    };
    const incoming: VaultData = {
      accounts: [makeAccount({ id: 'a', label: 'older', updatedAt: '2024-01-01T00:00:00.000Z' })],
    };
    const result = mergeVaultData(base, incoming);
    expect(result.data.accounts[0]?.label).toBe('newer');
    expect(result.overwritten).toBe(1);
    expect(result.updated).toBe(0);
  });

  it('updatedAt が同じでも入力順によらず同じ結果になる', () => {
    const a = makeAccount({ id: 'same', label: 'alpha', updatedAt: '2024-05-01T00:00:00.000Z' });
    const b = makeAccount({ id: 'same', label: 'beta', updatedAt: '2024-05-01T00:00:00.000Z' });
    const forward = mergeVaultData({ accounts: [a] }, { accounts: [b] });
    const backward = mergeVaultData({ accounts: [b] }, { accounts: [a] });
    expect(forward.data.accounts[0]).toEqual(backward.data.accounts[0]);
    // どちらか一方が必ず選ばれ、両方の結果が一致する。
    const chosen = forward.data.accounts[0]?.label;
    expect(['alpha', 'beta']).toContain(chosen);
  });

  it('内容が同じなら updated/overwritten を数えない', () => {
    const a = makeAccount({ id: 'same', label: 'same' });
    const result = mergeVaultData({ accounts: [a] }, { accounts: [{ ...a }] });
    expect(result.updated).toBe(0);
    expect(result.overwritten).toBe(0);
    expect(result.added).toBe(0);
  });

  it('削除記録があるアカウントは、保持している側とマージしても復活しない', () => {
    const deleted = makeAccount({ id: 'gone', updatedAt: '2024-05-01T00:00:00.000Z' });
    const tombstone = { id: 'gone', deletedAt: '2024-05-02T00:00:00.000Z' };
    // 端末 A: 削除済み（tombstone あり）、端末 B: まだ持っている。
    const a: VaultData = { accounts: [], tombstones: [tombstone] };
    const b: VaultData = { accounts: [deleted], tombstones: [] };
    for (const merged of [mergeVaultData(a, b), mergeVaultData(b, a)]) {
      expect(merged.data.accounts.map((account) => account.id)).not.toContain('gone');
      expect(merged.data.tombstones).toEqual([tombstone]);
      expect(merged.deleted).toBe(1);
    }
  });

  it('削除記録で除外したアカウントは追加・更新件数に数えない', () => {
    const tombstone = { id: 'x', deletedAt: '2024-05-02T00:00:00.000Z' };
    const stale = makeAccount({ id: 'x', updatedAt: '2024-05-01T00:00:00.000Z' });
    const result = mergeVaultData(
      { accounts: [], tombstones: [tombstone] },
      { accounts: [stale], tombstones: [] },
    );
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(1);
    expect(result.data.accounts).toHaveLength(0);
  });

  it('削除後に再加したアカウント（updatedAt が新しい）は残す', () => {
    const tombstone = { id: 'back', deletedAt: '2024-05-01T00:00:00.000Z' };
    const readded = makeAccount({ id: 'back', label: 're-added', updatedAt: '2024-05-03T00:00:00.000Z' });
    const result = mergeVaultData(
      { accounts: [], tombstones: [tombstone] },
      { accounts: [readded], tombstones: [] },
    );
    expect(result.data.accounts.map((account) => account.label)).toEqual(['re-added']);
    expect(result.deleted).toBe(0);
  });

  it('同じ id の削除記録は新しい deletedAt を残す', () => {
    const merged = mergeTombstones(
      [{ id: 'x', deletedAt: '2024-01-01T00:00:00.000Z' }],
      [{ id: 'x', deletedAt: '2024-02-01T00:00:00.000Z' }, { id: 'y', deletedAt: '2024-01-01T00:00:00.000Z' }],
    );
    expect(merged).toEqual([
      { id: 'x', deletedAt: '2024-02-01T00:00:00.000Z' },
      { id: 'y', deletedAt: '2024-01-01T00:00:00.000Z' },
    ]);
  });

  it('空のボルト同士でも壊れない', () => {
    const result = mergeVaultData({ accounts: [] }, { accounts: [] });
    expect(result.data.accounts).toEqual([]);
  });

  it('ピン留めが先、次に order で並ぶ', () => {
    const base: VaultData = {
      accounts: [
        makeAccount({ id: 'a', order: 0 }),
        makeAccount({ id: 'b', order: 1 }),
        makeAccount({ id: 'c', order: 2, pinned: true }),
      ],
    };
    const result = mergeVaultData(base, { accounts: [] });
    expect(result.data.accounts.map((a) => a.id)).toEqual(['c', 'a', 'b']);
  });

  it('重複検出は issuer+label+secret（大文字小文字無視）', () => {
    const existing = [makeAccount({ id: 'a', issuer: 'GitHub', label: 'me@example.com' })];
    expect(accountFingerprint(existing[0] as Account)).toBe('github\u0000me@example.com\u0000JBSWY3DPEHPK3PXP');
    const duplicates = findDuplicates(existing, [
      { issuer: 'github', label: 'ME@example.com', secret: 'JBSWY3DPEHPK3PXP' },
      { issuer: 'GitHub', label: 'other@example.com', secret: 'JBSWY3DPEHPK3PXP' },
    ]);
    expect([...duplicates]).toEqual([0]);
  });

  it('入力リスト内の重複も検出する', () => {
    const duplicates = findDuplicates(
      [],
      [
        { issuer: 'A', label: 'x', secret: 'S' },
        { issuer: 'A', label: 'x', secret: 'S' },
      ],
    );
    expect([...duplicates]).toEqual([1]);
  });

  it('ゴミ箱のアカウントは 30 日を過ぎるとマージで完全削除される', () => {
    const now = Date.parse('2026-11-20T00:00:00.000Z');
    const old = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    const base: VaultData = {
      accounts: [
        makeAccount({ id: 'stale', deletedAt: old, updatedAt: old }),
        makeAccount({ id: 'fresh', deletedAt: fresh, updatedAt: fresh }),
      ],
    };
    const result = mergeVaultData(base, { accounts: [] }, { now });
    expect(result.data.accounts.map((a) => a.id)).toEqual(['fresh']);
    expect(result.data.tombstones).toEqual([{ id: 'stale', deletedAt: old }]);
    expect(result.deleted).toBe(1);
  });

  it('端末一覧は id 単位で、lastSyncedAt が新しい方を採る', () => {
    const base: VaultData = {
      accounts: [],
      devices: [
        { id: 'phone', name: 'Pixel', platform: 'Android', lastSyncedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'pc', name: 'Desktop', platform: 'Windows', lastSyncedAt: '2026-01-02T00:00:00.000Z' },
      ],
    };
    const incoming: VaultData = {
      accounts: [],
      devices: [
        { id: 'phone', name: 'Pixel 8', platform: 'Android', lastSyncedAt: '2026-03-01T00:00:00.000Z' },
        { id: 'tablet', name: 'iPad', platform: 'iOS', lastSyncedAt: '2026-02-01T00:00:00.000Z' },
      ],
    };
    const result = mergeVaultData(base, incoming);
    expect(result.data.devices?.map((device) => [device.id, device.name])).toEqual([
      ['pc', 'Desktop'],
      ['phone', 'Pixel 8'],
      ['tablet', 'iPad'],
    ]);
  });

  it('端末一覧のマージは入力順に依存しない', () => {
    const older = [
      { id: 'a', name: 'old', platform: 'iOS', lastSyncedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const newer = [
      { id: 'a', name: 'new', platform: 'iOS', lastSyncedAt: '2026-02-01T00:00:00.000Z' },
    ];
    expect(mergeDevices(older, newer)).toEqual(mergeDevices(newer, older));
    expect(mergeDevices(older, newer)[0]?.name).toBe('new');
  });
});
