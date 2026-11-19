/**
 * 同期トークンとボルト ID。
 *
 * vaultId = hex(SHA-256(token))[0:32]
 * サーバーは vaultId と tokenHash（SHA-256 hex 全長）のみ保存する。
 */

import { bytesToBase64Url, bytesToHex, randomBytes, utf8ToBytes } from './encoding';

export const TOKEN_BYTES = 32;
export const VAULT_ID_LENGTH = 32;

export async function sha256Hex(input: Uint8Array | string): Promise<string> {
  const bytes = typeof input === 'string' ? utf8ToBytes(input) : input;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return bytesToHex(new Uint8Array(digest));
}

export function generateSyncToken(): string {
  return bytesToBase64Url(randomBytes(TOKEN_BYTES));
}

export function isValidSyncToken(token: string): boolean {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return false;
  try {
    const normalized = token.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return atob(padded).length === TOKEN_BYTES;
  } catch {
    return false;
  }
}

export async function deriveVaultId(token: string): Promise<string> {
  const hash = await sha256Hex(token);
  return hash.slice(0, VAULT_ID_LENGTH);
}

export async function deriveTokenHash(token: string): Promise<string> {
  return sha256Hex(token);
}

export function isValidVaultId(id: string): boolean {
  return /^[0-9a-f]{32}$/.test(id);
}

/** 同期コードをユーザー入力向けに整形する（4 文字区切り）。 */
export function formatSyncCode(token: string): string {
  return token.replace(/(.{4})/g, '$1 ').trim();
}

export function normalizeSyncCode(input: string): string {
  // base64url の '-' は正当な文字なので、空白のみを除去する。
  return input.replace(/\s/g, '');
}
