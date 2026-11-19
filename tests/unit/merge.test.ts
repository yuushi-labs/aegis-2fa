import { describe, expect, it } from 'vitest';
import { accountFingerprint, findDuplicates, mergeVaultData } from '../../shared/merge';
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
});
