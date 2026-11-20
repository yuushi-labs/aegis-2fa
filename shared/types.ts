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

/** 削除の記録。同期マージで削除済みアカウントが復活しないようにする。 */
export type Tombstone = {
  id: string;
  /** 削除した時刻（ISO 8601）。アカウントの updatedAt と比較する。 */
  deletedAt: string;
};

export type VaultData = {
  accounts: Account[];
  /** 削除記録（古いバックアップには無いため任意） */
  tombstones?: Tombstone[];
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

/**
 * パスキー / セキュリティキーによる解除の登録情報。
 * 端末の IndexedDB にだけ保存し、サーバーへは送らない（同期もしない）。
 */
export type PasskeyRecord = {
  /** レコード形式のバージョン */
  v: 1;
  /** credentialId（base64）。WebAuthn の rawId */
  id: string;
  /** 表示名（未入力なら既定名） */
  name: string;
  /** 登録日時（ISO 8601） */
  createdAt: string;
  /**
   * PRF の eval に渡す salt（base64、32B）。同じボルトのパスキーは同じ値を使う
   * （1 回の get でどの認証器を選んでも同じ KEK になるようにするため）。
   */
  prfSalt: string;
  /** このパスキー由来の KEK でラップした DEK（AAD は aegis-passkey-v1） */
  wrappedDek: VaultCipher;
  /** 登録時の封筒の指紋（パスワード変更では変わるが DEK が同じなら有効） */
  vaultFingerprint: string;
  /** 登録時の封筒の verifier（DEK の同一性。別ボルトの登録を検出する） */
  verifier: string;
  /** 認証器が申告した transports（allowCredentials のヒント） */
  transports?: string[];
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
/**
 * 受け入れる PBKDF2 反復回数の下限・上限。
 * 上限は外部（バックアップ封筒）から持ち込まれた値で端末を長時間占有させないために設ける。
 */
export const MIN_KDF_ITERATIONS = 100_000;
export const MAX_KDF_ITERATIONS = 1_000_000;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PERIOD = 300;
export const MIN_PERIOD = 1;
export const MAX_CLOCK_SKEW = 2;
