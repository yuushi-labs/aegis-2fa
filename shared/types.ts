/**
 * 両者共通の型定義。DOM 非依存。
 */

export type OtpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export type AccountType = 'totp' | 'hotp';

export type Account = {
  /** uuid v4 */
  id: string;
  type: AccountType;
  /** サービス名（空可） */
  issuer: string;
  /** アカウント名（メール等） */
  label: string;
  /** Base32（パディング無し・大文字正規化） */
  secret: string;
  algorithm: OtpAlgorithm;
  digits: 6 | 8;
  /** TOTP のみ。既定 30、1〜300 */
  period: number;
  /** HOTP のみ。0 以上 */
  counter: number;
  pinned: boolean;
  order: number;
  createdAt: string;
  updatedAt: string;
};

export type VaultData = {
  accounts: Account[];
};

export type VaultKdf = {
  name: 'PBKDF2-SHA256';
  iterations: number;
  /** base64 */
  salt: string;
};

export type VaultCipher = {
  /** base64 */
  iv: string;
  /** base64 */
  ciphertext: string;
};

export type VaultEnvelope = {
  format: 'aegis-vault';
  version: 1;
  kdf: VaultKdf;
  wrappedKey: VaultCipher;
  data: VaultCipher;
  /** HMAC-SHA256(DEK, "aegis-verify-v1") の先頭 16 バイト（base64） */
  verifier: string;
  revision: number;
  updatedAt: string;
};

export type VaultRecord = {
  envelope: VaultEnvelope;
  revision: number;
};

export type SyncStatus = 'local-only' | 'synced' | 'pending' | 'error' | 'conflict';

export const DEFAULT_ACCOUNT: Omit<Account, 'id' | 'secret' | 'createdAt' | 'updatedAt'> = {
  type: 'totp',
  issuer: '',
  label: '',
  algorithm: 'SHA1',
  digits: 6,
  period: 30,
  counter: 0,
  pinned: false,
  order: 0,
};

export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PERIOD = 300;
export const MIN_PERIOD = 1;
export const MAX_CLOCK_SKEW = 2;
