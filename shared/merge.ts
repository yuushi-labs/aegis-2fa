/**
 * 同期の競合解決: アカウント id 単位の union。
 * 同一 id は updatedAt が新しい方を採る。
 *
 * updatedAt が同じ場合は、内容を安定した順序で直列化して比較し、
 * 引数の順序（どちらが base か）によらず同じ結果になるようにする。
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

/** キー順を固定した JSON 文字列（内容比較用）。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** 内容の安定比較。同じ内容なら 0、辞書順で大きい方が正。 */
export function compareAccountContent(a: Account, b: Account): number {
  const left = stableStringify(a);
  const right = stableStringify(b);
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function isNewer(candidate: Account, current: Account): boolean {
  const a = Date.parse(candidate.updatedAt);
  const b = Date.parse(current.updatedAt);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    if (candidate.updatedAt !== current.updatedAt) return candidate.updatedAt > current.updatedAt;
  } else if (a !== b) {
    return a > b;
  }
  // 同時刻（または比較不能）: 内容で決める（入力順に依存しない）。
  return compareAccountContent(candidate, current) > 0;
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
    } else if (compareAccountContent(candidate, current) === 0) {
      // 完全に同一なら件数に数えない。
      continue;
    } else if (isNewer(candidate, current)) {
      byId.set(candidate.id, candidate);
      updated += 1;
    } else {
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
