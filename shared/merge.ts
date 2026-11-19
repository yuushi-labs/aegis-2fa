/**
 * 同期の競合解決: アカウント id 単位の union。
 * 同一 id は updatedAt が新しい方を採る。
 */

import type { Account, VaultData } from './types';

export type MergeResult = {
  data: VaultData;
  /** マージで増えた件数 */
  added: number;
  /** 更新された件数 */
  updated: number;
  /** 失われた（ローカル側で上書きされた）件数 */
  overwritten: number;
};

function isNewer(candidate: Account, current: Account): boolean {
  const a = Date.parse(candidate.updatedAt);
  const b = Date.parse(current.updatedAt);
  if (Number.isNaN(a) || Number.isNaN(b)) return candidate.updatedAt > current.updatedAt;
  if (a !== b) return a > b;
  return candidate.id > current.id;
}

export function mergeVaultData(base: VaultData, incoming: VaultData): MergeResult {
  const byId = new Map<string, Account>();
  for (const account of base.accounts) {
    byId.set(account.id, account);
  }
  let added = 0;
  let updated = 0;
  let overwritten = 0;

  for (const candidate of incoming.accounts) {
    const current = byId.get(candidate.id);
    if (current === undefined) {
      byId.set(candidate.id, candidate);
      added += 1;
    } else if (isNewer(candidate, current)) {
      byId.set(candidate.id, candidate);
      updated += 1;
    } else if (isNewer(current, candidate)) {
      overwritten += 1;
    }
  }

  const accounts = [...byId.values()].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    return a.createdAt.localeCompare(b.createdAt);
  });

  return { data: { accounts }, added, updated, overwritten };
}

/** 重複判定キー: issuer + label + secret。 */
export function accountFingerprint(account: Pick<Account, 'issuer' | 'label' | 'secret'>): string {
  return `${account.issuer.toLowerCase()}\u0000${account.label.toLowerCase()}\u0000${account.secret}`;
}

export function findDuplicates(
  existing: readonly Account[],
  candidates: readonly Pick<Account, 'issuer' | 'label' | 'secret'>[],
): Set<number> {
  const seen = new Set(existing.map(accountFingerprint));
  const duplicates = new Set<number>();
  candidates.forEach((candidate, index) => {
    const key = accountFingerprint(candidate);
    if (seen.has(key)) {
      duplicates.add(index);
    } else {
      seen.add(key);
    }
  });
  return duplicates;
}
