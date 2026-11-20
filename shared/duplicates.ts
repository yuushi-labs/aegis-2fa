/**
 * 重複チェック。
 *
 * 同じワンタイムパスワードを二重に登録すると、どちらを消すべきか分からず
 * 混乱する。追加しようとしているアカウントが
 * - 正規化した秘密鍵が同じ、または
 * - サービス名 + アカウント名（大文字小文字を無視）が同じ
 * 既存の（ゴミ箱にない）アカウントを指摘する。
 *
 * 既存の `findDuplicates`（移行 URI の取り込み用）は「サービス名 + アカウント名 +
 * 秘密鍵」の完全一致で判定する。こちらは 1 つでも当てはまれば警告する。
 */

import { canonicalBase32 } from './base32';
import type { Account } from './types';

export type DuplicateReason = 'secret' | 'label';

export type DuplicateMatch = {
  account: Account;
  reasons: DuplicateReason[];
};

type DuplicateCandidate = Pick<Account, 'issuer' | 'label' | 'secret' | 'deletedAt'>;

function normaliseSecret(value: string): string {
  try {
    return canonicalBase32(value);
  } catch {
    return value.replace(/[\s-]/g, '').toUpperCase();
  }
}

/** 「サービス名 + アカウント名」の比較キー（大文字小文字・前後空白を無視）。 */
function labelKey(candidate: Pick<Account, 'issuer' | 'label'>): string {
  return `${candidate.issuer.trim().toLowerCase()}\u0000${candidate.label.trim().toLowerCase()}`;
}

export function findAccountDuplicates(
  existing: readonly Account[],
  candidate: DuplicateCandidate,
): DuplicateMatch[] {
  const secret = normaliseSecret(candidate.secret);
  const key = labelKey(candidate);
  const matches: DuplicateMatch[] = [];
  for (const account of existing) {
    // ゴミ箱のアカウントは重複として数えない（復元するかもしれないだけ）。
    if (typeof account.deletedAt === 'string' && account.deletedAt !== '') continue;
    const reasons: DuplicateReason[] = [];
    if (secret !== '' && normaliseSecret(account.secret) === secret) reasons.push('secret');
    if (key !== '\u0000' && labelKey(account) === key) reasons.push('label');
    if (reasons.length > 0) matches.push({ account, reasons });
  }
  return matches;
}
