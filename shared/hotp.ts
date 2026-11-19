/**
 * RFC 4226 HOTP。HMAC は Web Crypto（crypto.subtle）を使う。
 */

import type { OtpAlgorithm } from './types';
import { hexToBytes } from './encoding';

const WEB_CRYPTO_HASH: Record<OtpAlgorithm, string> = {
  SHA1: 'SHA-1',
  SHA256: 'SHA-256',
  SHA512: 'SHA-512',
};

export async function hmac(
  algorithm: OtpAlgorithm,
  key: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    toArrayBuffer(key),
    { name: 'HMAC', hash: WEB_CRYPTO_HASH[algorithm] },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', cryptoKey, toArrayBuffer(message));
  return new Uint8Array(signature);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function counterToBytes(counter: number): Uint8Array {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new Error('カウンタは 0 以上の安全な整数である必要があります');
  }
  const bytes = new Uint8Array(8);
  let value = counter;
  for (let i = 7; i >= 0; i -= 1) {
    bytes[i] = value % 256;
    value = Math.floor(value / 256);
  }
  return bytes;
}

/** RFC 4226 の dynamic truncation。 */
export function dynamicTruncate(digest: Uint8Array): number {
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binCode =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);
  return binCode >>> 0;
}

export function truncateToDigits(binaryCode: number, digits: number): string {
  if (!Number.isInteger(digits) || digits < 1 || digits > 10) {
    throw new Error('桁数は 1〜10 の整数である必要があります');
  }
  const modulo = 10 ** digits;
  return (binaryCode % modulo).toString().padStart(digits, '0');
}

/** RFC 4226 の HOTP 値を返す（非同期）。 */
export async function generateHOTP(
  key: Uint8Array,
  counter: number,
  options: { algorithm?: OtpAlgorithm; digits?: number } = {},
): Promise<string> {
  const algorithm = options.algorithm ?? 'SHA1';
  const digits = options.digits ?? 6;
  const digest = await hmac(algorithm, key, counterToBytes(counter));
  return truncateToDigits(dynamicTruncate(digest), digits);
}

/** 16 進文字列の秘密鍵を使う簡易版（テストベクタ用）。 */
export async function hotpFromHex(
  hexSecret: string,
  counter: number,
  options: { algorithm?: OtpAlgorithm; digits?: number } = {},
): Promise<string> {
  return generateHOTP(hexToBytes(hexSecret), counter, options);
}
