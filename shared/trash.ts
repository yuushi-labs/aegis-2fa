/**
 * ゴミ箱（30 日で完全削除）。
 *
 * 削除は 2 段階にする。
 * 1. ゴミ箱へ移動: `deletedAt` に時刻を入れるだけ。tombstone は作らない
 *    （他の端末にも「ゴミ箱に行った」状態がそのまま同期される）。
 * 2. 完全削除: アカウントを取り除き、tombstone に記録する（復活を防ぐ）。
 *
 * `deletedAt` から 30 日を過ぎたものは、読み込み・同期マージのたびに 2. へ進める。
 */

import { TRASH_RETENTION_DAYS } from './types';

export { TRASH_RETENTION_DAYS };
import type { Account, Tombstone, VaultData } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * DAY_MS;

export function isTrashed(account: Pick<Account, 'deletedAt'>): boolean {
  return typeof account.deletedAt === 'string' && account.deletedAt !== '';
}

/** 完全削除される時刻（ミリ秒）。ゴミ箱でなければ null。 */
export function trashExpiresAt(account: Pick<Account, 'deletedAt'>): number | null {
  if (!isTrashed(account)) return null;
  const deleted = Date.parse(account.deletedAt as string);
  if (Number.isNaN(deleted)) return null;
  return deleted + TRASH_RETENTION_MS;
}

/** 自動完全削除までの残り日数（切り上げ。今日中なら 1）。判定不能なら 0。 */
export function trashRemainingDays(
  account: Pick<Account, 'deletedAt'>,
  now: number = Date.now(),
): number {
  const expiresAt = trashExpiresAt(account);
  if (expiresAt === null) return 0;
  const remaining = expiresAt - now;
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / DAY_MS);
}

/** 30 日を過ぎて完全削除の対象になったか。 */
export function isTrashExpired(
  account: Pick<Account, 'deletedAt'>,
  now: number = Date.now(),
): boolean {
  const expiresAt = trashExpiresAt(account);
  if (expiresAt === null) return false;
  return now >= expiresAt;
}

/** 一覧を「有効」「ゴミ箱」「期限切れ」に分ける。 */
export function splitAccounts(
  accounts: readonly Account[],
  now: number = Date.now(),
): { active: Account[]; trashed: Account[]; expired: Account[] } {
  const active: Account[] = [];
  const trashed: Account[] = [];
  const expired: Account[] = [];
  for (const account of accounts) {
    if (!isTrashed(account)) active.push(account);
    else if (isTrashExpired(account, now)) expired.push(account);
    else trashed.push(account);
  }
  return { active, trashed, expired };
}

/** 期限切れのゴミ箱を完全削除し、tombstone に記録する。 */
export function purgeExpiredTrash(
  accounts: readonly Account[],
  tombstones: readonly Tombstone[],
  now: number = Date.now(),
): VaultData & { purged: number } {
  const kept: Account[] = [];
  const added: Tombstone[] = [];
  for (const account of accounts) {
    if (isTrashExpired(account, now)) {
      added.push({ id: account.id, deletedAt: account.deletedAt as string });
      continue;
    }
    kept.push(account);
  }
  if (added.length === 0) {
    return { accounts: [...accounts], tombstones: [...tombstones], purged: 0 };
  }
  const byId = new Map<string, Tombstone>();
  for (const tombstone of [...tombstones, ...added]) {
    const current = byId.get(tombstone.id);
    if (current === undefined || tombstone.deletedAt > current.deletedAt) {
      byId.set(tombstone.id, tombstone);
    }
  }
  return { accounts: kept, tombstones: [...byId.values()], purged: added.length };
}
