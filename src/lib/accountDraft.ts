import type { Account, OtpAlgorithm, RecoveryCode } from '../../shared/types';
import { DEFAULT_ACCOUNT, MAX_RECOVERY_CODES, MAX_RECOVERY_CODE_LENGTH } from '../../shared/types';
import { canonicalBase32 } from '../../shared/base32';

export type AccountDraft = {
  type: 'totp' | 'hotp';
  issuer: string;
  label: string;
  secret: string;
  algorithm: OtpAlgorithm;
  digits: 6 | 8;
  period: number;
  counter: number;
  /** サービスごとのメモ（空なら保存しない） */
  notes: string;
  /** 使い捨てバックアップコード（使用済みの印を含む） */
  recoveryCodes: RecoveryCode[];
};

export const EMPTY_DRAFT: AccountDraft = {
  type: DEFAULT_ACCOUNT.type,
  issuer: '',
  label: '',
  secret: '',
  algorithm: DEFAULT_ACCOUNT.algorithm,
  digits: DEFAULT_ACCOUNT.digits,
  period: DEFAULT_ACCOUNT.period,
  counter: DEFAULT_ACCOUNT.counter,
  notes: '',
  recoveryCodes: [],
};

/** 入力されたコード列を整える（空行・重複・長すぎるものを落とす）。 */
export function normaliseRecoveryCodes(codes: readonly RecoveryCode[]): RecoveryCode[] {
  const seen = new Set<string>();
  const result: RecoveryCode[] = [];
  for (const entry of codes) {
    const code = entry.code.trim();
    if (code === '' || code.length > MAX_RECOVERY_CODE_LENGTH) continue;
    const key = code.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ id: entry.id, code, used: entry.used === true });
    if (result.length >= MAX_RECOVERY_CODES) break;
  }
  return result;
}

export function draftToAccount(
  draft: AccountDraft,
  existing: Account | null,
  id: string,
  nowIso: string,
): Account {
  const notes = draft.notes.trim();
  const recoveryCodes = normaliseRecoveryCodes(draft.recoveryCodes);
  return {
    id,
    type: draft.type,
    issuer: draft.issuer.trim(),
    label: draft.label.trim(),
    secret: canonicalBase32(draft.secret),
    algorithm: draft.algorithm,
    digits: draft.digits,
    period: draft.period,
    counter: draft.counter,
    pinned: existing?.pinned ?? false,
    order: existing?.order ?? 0,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
    // 空にした項目は持たせない（消したメモが残らないように）。
    ...(notes === '' ? {} : { notes }),
    ...(recoveryCodes.length === 0 ? {} : { recoveryCodes }),
    // 既存の状態（ゴミ箱・使用回数）は編集で失わない。
    ...(existing?.deletedAt === undefined ? {} : { deletedAt: existing.deletedAt }),
    ...(existing?.useCount === undefined ? {} : { useCount: existing.useCount }),
    ...(existing?.lastUsedAt === undefined ? {} : { lastUsedAt: existing.lastUsedAt }),
  };
}

export function accountToDraft(account: Account): AccountDraft {
  return {
    type: account.type,
    issuer: account.issuer,
    label: account.label,
    secret: account.secret,
    algorithm: account.algorithm,
    digits: account.digits,
    period: account.period,
    counter: account.counter,
    notes: account.notes ?? '',
    recoveryCodes: account.recoveryCodes ?? [],
  };
}
