/**
 * RFC 4648 Base32（パディング無しで出力、入力は小文字・空白・'=' を許容）。
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const LOOKUP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i += 1) {
  LOOKUP[ALPHABET[i] as string] = i;
}

export class Base32Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Base32Error';
  }
}

/** 入力の正規化。大文字化し、空白とパディングを除去する。 */
export function normalizeBase32(input: string): string {
  return input.replace(/[\s=]/g, '').toUpperCase();
}

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function decodeBase32(input: string): Uint8Array {
  const normalized = normalizeBase32(input);
  if (normalized.length === 0) {
    throw new Base32Error('Base32 文字列が空です');
  }
  for (const char of normalized) {
    if (!(char in LOOKUP)) {
      throw new Base32Error(`Base32 に使用できない文字が含まれています: ${char}`);
    }
  }
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of normalized) {
    value = (value << 5) | (LOOKUP[char] as number);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bits >= 5) {
    throw new Base32Error('Base32 文字列の長さが不正です');
  }
  return Uint8Array.from(bytes);
}

/** 正規化と妥当性検証を行い、正規化済み文字列を返す。
 * 未使用ビットの違い（例: MY と MZ はどちらも [0x66]）も同じ文字列に揃えるため、
 * 復号したバイト列を再エンコードした結果を返す。
 */
export function canonicalBase32(input: string): string {
  return encodeBase32(decodeBase32(input));
}

export function isValidBase32(input: string): boolean {
  try {
    decodeBase32(input);
    return true;
  } catch {
    return false;
  }
}
