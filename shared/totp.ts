/**
 * RFC 6238 TOTP。HOTP の上に時間ステップを載せるだけ。
 */

import { decodeBase32 } from './base32';
import { generateHOTP } from './hotp';
import { MAX_CLOCK_SKEW, MAX_PERIOD, MIN_PERIOD } from './types';
import type { OtpAlgorithm } from './types';

export type TotpOptions = {
  algorithm?: OtpAlgorithm;
  digits?: number;
  period?: number;
};

export function currentStep(unixSeconds: number, period: number): number {
  if (!Number.isFinite(unixSeconds)) throw new Error('時刻が不正です');
  if (!Number.isInteger(period) || period < MIN_PERIOD || period > MAX_PERIOD) {
    throw new Error(`period は ${MIN_PERIOD}〜${MAX_PERIOD} の整数である必要があります`);
  }
  return Math.floor(unixSeconds / period);
}

export function secondsRemaining(unixSeconds: number, period: number): number {
  if (!Number.isInteger(period) || period < MIN_PERIOD) {
    throw new Error('period が不正です');
  }
  return period - (Math.floor(unixSeconds) % period);
}

export function clampSkew(skew: number): number {
  if (!Number.isInteger(skew)) return 0;
  return Math.max(-MAX_CLOCK_SKEW, Math.min(MAX_CLOCK_SKEW, skew));
}

/** Base32 秘密鍵と Unix 秒から TOTP を生成する。 */
export async function generateTOTP(
  secret: string,
  unixSeconds: number,
  options: TotpOptions = {},
): Promise<string> {
  const algorithm = options.algorithm ?? 'SHA1';
  const digits = options.digits ?? 6;
  const period = options.period ?? 30;
  const counter = currentStep(unixSeconds, period);
  return generateHOTP(decodeBase32(secret), counter, { algorithm, digits });
}

/** 現在コードと次期コードをまとめて返す（表示用）。 */
export async function generateTOTPPair(
  secret: string,
  unixSeconds: number,
  options: TotpOptions & { skew?: number } = {},
): Promise<{ current: string; next: string; counter: number; remaining: number }> {
  const period = options.period ?? 30;
  const skew = clampSkew(options.skew ?? 0);
  const counter = currentStep(unixSeconds, period) + skew;
  const key = decodeBase32(secret);
  const hotpOptions = { algorithm: options.algorithm ?? 'SHA1', digits: options.digits ?? 6 };
  const [current, next] = await Promise.all([
    generateHOTP(key, counter, hotpOptions),
    generateHOTP(key, counter + 1, hotpOptions),
  ]);
  return { current, next, counter, remaining: secondsRemaining(unixSeconds, period) };
}

/** 検証（サーバー側やテスト用）。許容ステップ幅 ±window。 */
export async function verifyTOTP(
  secret: string,
  token: string,
  unixSeconds: number,
  options: TotpOptions & { window?: number } = {},
): Promise<boolean> {
  const period = options.period ?? 30;
  const window = options.window ?? 1;
  const key = decodeBase32(secret);
  const hotpOptions = { algorithm: options.algorithm ?? 'SHA1', digits: options.digits ?? 6 };
  const step = currentStep(unixSeconds, period);
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = await generateHOTP(key, step + offset, hotpOptions);
    if (candidate === token) return true;
  }
  return false;
}
