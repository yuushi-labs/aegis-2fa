/**
 * otpauth:// URI のパースと生成（往復で意味が変わらないこと）。
 *
 * otpauth://totp/Issuer:account?secret=...&issuer=...&algorithm=SHA1&digits=6&period=30
 * otpauth://hotp/Issuer:account?secret=...&issuer=...&counter=0
 */

import { canonicalBase32 } from './base32';
import { DEFAULT_ACCOUNT, MAX_PERIOD, MIN_PERIOD } from './types';
import type { Account, AccountType, OtpAlgorithm } from './types';

export class OtpauthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtpauthError';
  }
}

export type OtpauthParams = {
  type: AccountType;
  issuer: string;
  label: string;
  secret: string;
  algorithm: OtpAlgorithm;
  digits: 6 | 8;
  period: number;
  counter: number;
};

const ALGORITHMS: readonly OtpAlgorithm[] = ['SHA1', 'SHA256', 'SHA512'];

function normalizeAlgorithm(raw: string | null): OtpAlgorithm {
  if (raw === null || raw.trim() === '') return 'SHA1';
  const upper = raw.trim().toUpperCase().replace(/-/g, '');
  const normalized = upper === 'SHA1' ? 'SHA1' : upper === 'SHA256' ? 'SHA256' : upper === 'SHA512' ? 'SHA512' : null;
  if (normalized === null || !ALGORITHMS.includes(normalized)) {
    throw new OtpauthError(`未対応のアルゴリズムです: ${raw}`);
  }
  return normalized;
}

function normalizeDigits(raw: string | null): 6 | 8 {
  if (raw === null || raw.trim() === '') return 6;
  const value = Number.parseInt(raw.trim(), 10);
  if (value !== 6 && value !== 8) {
    throw new OtpauthError(`桁数は 6 か 8 のみ対応しています: ${raw}`);
  }
  return value;
}

function normalizePeriod(raw: string | null): number {
  if (raw === null || raw.trim() === '') return 30;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(value) || value < MIN_PERIOD || value > MAX_PERIOD) {
    throw new OtpauthError(`period は ${MIN_PERIOD}〜${MAX_PERIOD} の整数である必要があります: ${raw}`);
  }
  return value;
}

function normalizeCounter(raw: string | null): number {
  if (raw === null || raw.trim() === '') return 0;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OtpauthError(`counter は 0 以上の整数である必要があります: ${raw}`);
  }
  return value;
}

/** "Issuer:account" を分解する。区切りが無ければ issuer は空。 */
export function splitLabel(pathLabel: string): { issuer: string; label: string } {
  const decoded = safeDecode(pathLabel);
  const index = decoded.indexOf(':');
  if (index === -1) return { issuer: '', label: decoded.trim() };
  return {
    issuer: decoded.slice(0, index).trim(),
    label: decoded.slice(index + 1).trim(),
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseOtpauthUri(uri: string): OtpauthParams {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    throw new OtpauthError('URI として解釈できません');
  }
  if (url.protocol !== 'otpauth:') {
    throw new OtpauthError('otpauth:// スキームではありません');
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'totp' && host !== 'hotp') {
    throw new OtpauthError(`未対応の種別です: ${host}`);
  }
  const type: AccountType = host;

  const rawSecret = url.searchParams.get('secret');
  if (rawSecret === null || rawSecret.trim() === '') {
    throw new OtpauthError('secret パラメータがありません');
  }
  let secret: string;
  try {
    secret = canonicalBase32(rawSecret);
  } catch {
    throw new OtpauthError('secret が正しい Base32 ではありません');
  }

  const fromLabel = splitLabel(url.pathname.replace(/^\/+/, ''));
  const queryIssuer = url.searchParams.get('issuer');
  const issuer = queryIssuer !== null && queryIssuer.trim() !== '' ? queryIssuer.trim() : fromLabel.issuer;

  const params: OtpauthParams = {
    type,
    issuer,
    label: fromLabel.label,
    secret,
    algorithm: normalizeAlgorithm(url.searchParams.get('algorithm')),
    digits: normalizeDigits(url.searchParams.get('digits')),
    period: type === 'totp' ? normalizePeriod(url.searchParams.get('period')) : 30,
    counter: type === 'hotp' ? normalizeCounter(url.searchParams.get('counter')) : 0,
  };

  if (params.label === '' && params.issuer === '') {
    throw new OtpauthError('ラベル（アカウント名）がありません');
  }
  return params;
}

export function isOtpauthUri(value: string): boolean {
  return /^otpauth:\/\//i.test(value.trim());
}

export function isMigrationUri(value: string): boolean {
  return /^otpauth-migration:\/\//i.test(value.trim());
}

/** otpauth URI を生成する。 */
export function buildOtpauthUri(
  account: Pick<Account, 'type' | 'issuer' | 'label' | 'secret' | 'algorithm' | 'digits' | 'period' | 'counter'>,
): string {
  const path = account.issuer !== '' ? `${encodeURIComponent(account.issuer)}:${encodeURIComponent(account.label)}` : encodeURIComponent(account.label);
  const params = new URLSearchParams();
  params.set('secret', account.secret);
  if (account.issuer !== '') params.set('issuer', account.issuer);
  params.set('algorithm', account.algorithm);
  params.set('digits', String(account.digits));
  if (account.type === 'totp') {
    params.set('period', String(account.period));
  } else {
    params.set('counter', String(account.counter));
  }
  return `otpauth://${account.type}/${path}?${params.toString()}`;
}

export function toAccountDraft(params: OtpauthParams): Omit<Account, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    ...DEFAULT_ACCOUNT,
    type: params.type,
    issuer: params.issuer,
    label: params.label,
    secret: params.secret,
    algorithm: params.algorithm,
    digits: params.digits,
    period: params.period,
    counter: params.counter,
  };
}
