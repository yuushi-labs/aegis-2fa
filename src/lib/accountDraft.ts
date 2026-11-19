import type { Account, OtpAlgorithm } from '../../shared/types';
import { DEFAULT_ACCOUNT } from '../../shared/types';
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
};

export function draftToAccount(
  draft: AccountDraft,
  existing: Account | null,
  id: string,
  nowIso: string,
): Account {
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
  };
}

