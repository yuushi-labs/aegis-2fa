import { describe, expect, it } from 'vitest';
import {
  TRASH_RETENTION_DAYS,
  TRASH_RETENTION_MS,
  isTrashExpired,
  isTrashed,
  purgeExpiredTrash,
  splitAccounts,
  trashExpiresAt,
  trashRemainingDays,
} from '../../shared/trash';
import type { Account } from '../../shared/types';

const NOW = Date.parse('2026-11-20T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

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

describe('ゴミ箱（30 日）', () => {
  it('deletedAt が無いものはゴミ箱ではない', () => {
    expect(isTrashed(account('a'))).toBe(false);
    expect(isTrashed({ deletedAt: '' })).toBe(false);
    expect(trashExpiresAt(account('a'))).toBeNull();
    expect(isTrashExpired(account('a'), NOW)).toBe(false);
  });

  it('削除から 30 日で期限切れになる', () => {
    const deletedAt = new Date(NOW - 10 * DAY).toISOString();
    const target = account('a', { deletedAt });
    expect(trashExpiresAt(target)).toBe(Date.parse(deletedAt) + TRASH_RETENTION_MS);
    expect(TRASH_RETENTION_DAYS).toBe(30);
    expect(trashRemainingDays(target, NOW)).toBe(20);
    expect(isTrashExpired(target, NOW)).toBe(false);

    // 29 日目はまだ残る。
    const almost = account('b', { deletedAt: new Date(NOW - 29 * DAY).toISOString() });
    expect(trashRemainingDays(almost, NOW)).toBe(1);
    expect(isTrashExpired(almost, NOW)).toBe(false);

    // ちょうど 30 日で期限切れ（境界は削除側に倒す）。
    const expired = account('c', { deletedAt: new Date(NOW - 30 * DAY).toISOString() });
    expect(trashRemainingDays(expired, NOW)).toBe(0);
    expect(isTrashExpired(expired, NOW)).toBe(true);
  });

  it('壊れた日時は期限切れとして扱わない（勝手に消さない）', () => {
    const broken = account('a', { deletedAt: 'not-a-date' });
    expect(trashExpiresAt(broken)).toBeNull();
    expect(trashRemainingDays(broken, NOW)).toBe(0);
    expect(isTrashExpired(broken, NOW)).toBe(false);
  });

  it('有効・ゴミ箱・期限切れに分ける', () => {
    const list = [
      account('active'),
      account('trashed', { deletedAt: new Date(NOW - 5 * DAY).toISOString() }),
      account('expired', { deletedAt: new Date(NOW - 40 * DAY).toISOString() }),
    ];
    const split = splitAccounts(list, NOW);
    expect(split.active.map((item) => item.id)).toEqual(['active']);
    expect(split.trashed.map((item) => item.id)).toEqual(['trashed']);
    expect(split.expired.map((item) => item.id)).toEqual(['expired']);
  });

  it('期限切れは完全削除し、tombstone に記録する', () => {
    const list = [
      account('active'),
      account('trashed', { deletedAt: new Date(NOW - 5 * DAY).toISOString() }),
      account('expired', { deletedAt: new Date(NOW - 40 * DAY).toISOString() }),
    ];
    const result = purgeExpiredTrash(list, [], NOW);
    expect(result.purged).toBe(1);
    expect(result.accounts.map((item) => item.id)).toEqual(['active', 'trashed']);
    expect(result.tombstones).toEqual([
      { id: 'expired', deletedAt: new Date(NOW - 40 * DAY).toISOString() },
    ]);
  });

  it('期限切れが無ければ何も変えない（同じ配列を触らない）', () => {
    const list = [account('active')];
    const result = purgeExpiredTrash(list, [{ id: 'old', deletedAt: '2026-01-01T00:00:00.000Z' }], NOW);
    expect(result.purged).toBe(0);
    expect(result.accounts).toEqual(list);
    expect(result.tombstones).toHaveLength(1);
  });
});
