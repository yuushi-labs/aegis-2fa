/**
 * 両者共通の型定義。DOM 非依存。
 */

export type OtpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export type AccountType = 'totp' | 'hotp';

/** 使い捨てバックアップコード（使用済みを 1 件ずつ管理する）。 */
export type RecoveryCode = {
  /** uuid v4 */
  id: string;
  code: string;
  used: boolean;
};

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
  /** サービスごとのメモ（暗号化ペイロード内だけに置く） */
  notes?: string;
  /** バックアップコード（暗号化ペイロード内だけに置く） */
  recoveryCodes?: RecoveryCode[];
  /**
   * ゴミ箱へ移動した時刻（ISO 8601）。無ければ有効なアカウント。
   * 値があるあいだは通常の一覧・検索・コード生成の対象外にする。
   */
  deletedAt?: string;
  /** コードをコピー等した回数（「よく使う順」の並べ替えにだけ使う） */
  useCount?: number;
  /** 最後にコードを使った時刻（ISO 8601） */
  lastUsedAt?: string;
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
  /** 同期している端末の一覧（古いバックアップには無いため任意） */
  devices?: SyncDevice[];
  /**
   * パスキー登録のメタ情報（古いバックアップには無いため任意）。
   * 秘密（wrapped DEK・PRF salt・認証器の秘密鍵）は含めない。名前と登録端末を
   * 端末をまたいで表示するためだけに、暗号化されたボルトの中へ入れる。
   */
  passkeyInfos?: PasskeyInfo[];
};

/**
 * パスキー登録の「名前だけ」の記録。
 *
 * 端末ローカル（IndexedDB の PasskeyRecord）にある解除用の秘密は同期しない。
 * 別の端末では解除に使えないが、「どの端末にどの名前のパスキーがあるか」を
 * 一覧できるようにするための最小限の情報だけを、暗号化されたボルトの中で共有する。
 */
export type PasskeyInfo = {
  /** credentialId（base64）。その端末の PasskeyRecord.id と同じ値 */
  id: string;
  /** 表示名（未入力なら既定名） */
  name: string;
  /** 登録日時（ISO 8601） */
  createdAt: string;
  /** 登録した端末の ID（この端末の登録かどうかの判定に使う） */
  deviceId?: string;
  /** 登録した端末の名前 */
  deviceName?: string;
  /** 削除した時刻（ISO 8601）。あるものは一覧に出さない（削除を他の端末にも伝える） */
  deletedAt?: string;
};

/**
 * 同期している端末の記録。端末 ID は端末（ブラウザ）がローカルで作り、
 * 名前は利用者が変えられる。lastSyncedAt は push した時刻。
 */
export type SyncDevice = {
  id: string;
  name: string;
  /** 'Android' / 'iOS' / 'macOS' / 'Windows' / 'Linux' などの推定値 */
  platform: string;
  lastSyncedAt: string;
};

/** 1 つのブラウザ内に置くボルト（プロファイル）。マスターパスワードごとに独立する。 */
export type VaultProfile = {
  id: string;
  name: string;
  createdAt: string;
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
 * 解除に使う情報（credentialId・PRF salt・包んだ DEK）は端末の IndexedDB にだけ置き、
 * ほかの端末とは共有しない。表示名などの秘密でないメタ情報だけを
 * VaultData.passkeyInfos として暗号化ボルトの中で共有する。
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
/** ゴミ箱に置いておく日数。過ぎたら完全削除する。 */
export const TRASH_RETENTION_DAYS = 30;
/** プロファイル名の上限 */
export const MAX_PROFILE_NAME_LENGTH = 32;
/** 既定（既存の単一ボルトを引き継ぐ）プロファイルの ID。 */
export const DEFAULT_PROFILE_ID = 'main';
/** バックアップコード 1 件の長さの上限（貼り付けの取りこぼしを防ぐ） */
export const MAX_RECOVERY_CODE_LENGTH = 128;
export const MAX_RECOVERY_CODES = 50;
export const MAX_NOTES_LENGTH = 2_000;
