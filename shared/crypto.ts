/**
 * ゼロ知識ボルトの暗号処理。
 *
 * - KEK: PBKDF2-HMAC-SHA-256(iterations, salt 16B) → AES-256-GCM 鍵
 * - DEK: ランダム 32B。KEK で AES-256-GCM ラップ（IV 12B、AAD "aegis-vault-v1"）
 * - データ: DEK で AES-256-GCM（IV 12B、AAD "aegis-data-v1:<revision>"）
 * - verifier: HMAC-SHA-256(DEK, "aegis-verify-v1") の先頭 16B
 *
 * 平文の秘密鍵もパスワードもこのモジュールの外へは出さない（呼び出し側の責任）。
 *
 * 注意: AAD・verifier のメッセージ・封筒の `format` に残る `aegis-...` は、旧名（Aegis 2FA）
 * 時代に作ったボルトを同じ鍵で復号するための識別子で、**変更すると既存のボルトが開けなくなる**。
 * 表示名ではないので、製品名の変更には追従させない。
 */

import {
  base64ToBytes,
  bytesToBase64,
  bytesToUtf8,
  randomBytes,
  timingSafeEqual,
  utf8ToBytes,
} from './encoding';
import { hmac } from './hotp';
import { PBKDF2_ITERATIONS, MAX_KDF_ITERATIONS, MIN_KDF_ITERATIONS } from './types';
import type { VaultCipher, VaultEnvelope, VaultKdf } from './types';

/** DOM と Node の両方の型定義で通用する CryptoKey エイリアス。 */
type CryptoKeyLike = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;

/** 既存ボルト互換のため変更禁止（旧 Aegis 2FA 時代の AAD）。 */
const WRAP_AAD = utf8ToBytes('aegis-vault-v1');
/** 既存ボルト互換のため変更禁止（保存済み verifier の計算に使う）。 */
const VERIFY_MESSAGE = utf8ToBytes('aegis-verify-v1');
const VERIFIER_LENGTH = 16;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const DEK_LENGTH = 32;

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

export class WrongPasswordError extends CryptoError {
  constructor() {
    super('パスワードが違います');
    this.name = 'WrongPasswordError';
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export async function deriveKek(
  password: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKeyLike> {
  if (password.length === 0) throw new CryptoError('パスワードが空です');
  if (!Number.isInteger(iterations) || iterations < MIN_KDF_ITERATIONS) {
    throw new CryptoError('PBKDF2 の反復回数が少なすぎます');
  }
  // 外部の封筒（バックアップ等）が巨大な反復回数を主張しても、ここで打ち切る。
  if (iterations > MAX_KDF_ITERATIONS) {
    throw new CryptoError('PBKDF2 の反復回数が多すぎます');
  }
  const baseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    toArrayBuffer(utf8ToBytes(password)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(salt),
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function aesEncrypt(key: CryptoKeyLike, iv: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad) },
    key,
    toArrayBuffer(plaintext),
  );
  return new Uint8Array(ciphertext);
}

async function aesDecrypt(key: CryptoKeyLike, iv: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  try {
    const plaintext = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad) },
      key,
      toArrayBuffer(ciphertext),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new WrongPasswordError();
  }
}

export async function generateDek(): Promise<Uint8Array> {
  return randomBytes(DEK_LENGTH);
}

async function importDek(dek: Uint8Array): Promise<CryptoKeyLike> {
  return globalThis.crypto.subtle.importKey('raw', toArrayBuffer(dek), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function computeVerifier(dek: Uint8Array): Promise<Uint8Array> {
  const mac = await hmac('SHA256', dek, VERIFY_MESSAGE);
  return mac.slice(0, VERIFIER_LENGTH);
}

/** 既存ボルト互換のため変更禁止（暗号文の AAD）。 */
function dataAad(revision: number): Uint8Array {
  return utf8ToBytes(`aegis-data-v1:${revision}`);
}

export type CreateVaultOptions = {
  password: string;
  /** プレーンテキストの JSON 文字列（ボルトデータ） */
  plaintext: string;
  revision?: number;
  iterations?: number;
  updatedAt?: string;
  /** 既存 DEK（再暗号化・バックアップ用） */
  dek?: Uint8Array;
  /** 既存 salt（パスワード変更時） */
  salt?: Uint8Array;
};

/** ボルト封筒を新規作成する。 */
export async function createVaultEnvelope(options: CreateVaultOptions): Promise<VaultEnvelope> {
  const iterations = options.iterations ?? PBKDF2_ITERATIONS;
  const revision = options.revision ?? 1;
  const salt = options.salt ?? randomBytes(SALT_LENGTH);
  const dek = options.dek ?? (await generateDek());
  if (dek.length !== DEK_LENGTH) throw new CryptoError('DEK の長さが不正です');

  const kek = await deriveKek(options.password, salt, iterations);
  const wrapIv = randomBytes(IV_LENGTH);
  const wrappedKey = await aesEncrypt(kek, wrapIv, dek, WRAP_AAD);

  const dekKey = await importDek(dek);
  const dataIv = randomBytes(IV_LENGTH);
  const ciphertext = await aesEncrypt(dekKey, dataIv, utf8ToBytes(options.plaintext), dataAad(revision));

  const verifier = await computeVerifier(dek);

  return {
    // 封筒の形式識別子。既存ボルト・サーバー・Android アプリが同じ値で検証するため、
    // 旧名のまま固定する（表示名ではない）。
    format: 'aegis-vault',
    version: 1,
    kdf: { name: 'PBKDF2-SHA256', iterations, salt: bytesToBase64(salt) },
    wrappedKey: { iv: bytesToBase64(wrapIv), ciphertext: bytesToBase64(wrappedKey) },
    data: { iv: bytesToBase64(dataIv), ciphertext: bytesToBase64(ciphertext) },
    verifier: bytesToBase64(verifier),
    revision,
    updatedAt: options.updatedAt ?? new Date().toISOString(),
  };
}

export type UnlockedVault = {
  dek: Uint8Array;
  plaintext: string;
  revision: number;
};

/** 封筒を復号する。パスワード誤りは WrongPasswordError。 */
export async function unlockVaultEnvelope(envelope: VaultEnvelope, password: string): Promise<UnlockedVault> {
  const salt = base64ToBytes(envelope.kdf.salt);
  const kek = await deriveKek(password, salt, envelope.kdf.iterations);
  const wrapIv = base64ToBytes(envelope.wrappedKey.iv);
  const wrapped = base64ToBytes(envelope.wrappedKey.ciphertext);
  const dek = await aesDecrypt(kek, wrapIv, wrapped, WRAP_AAD);

  const expected = base64ToBytes(envelope.verifier);
  const actual = await computeVerifier(dek);
  if (!timingSafeEqual(expected, actual)) {
    throw new WrongPasswordError();
  }

  const dekKey = await importDek(dek);
  const dataIv = base64ToBytes(envelope.data.iv);
  const ciphertext = base64ToBytes(envelope.data.ciphertext);
  const plaintext = bytesToUtf8(await aesDecrypt(dekKey, dataIv, ciphertext, dataAad(envelope.revision)));
  return { dek, plaintext, revision: envelope.revision };
}

export type ReencryptOptions = {
  password: string;
  dek: Uint8Array;
  salt: Uint8Array;
  iterations: number;
  plaintext: string;
  revision: number;
  updatedAt?: string;
};

/** 既存 DEK/salt を維持したまま、データ部だけ差し替える（同期 PUT 用）。 */
export async function reencryptVaultData(options: ReencryptOptions): Promise<{ data: VaultCipher; verifier: string }> {
  const dekKey = await importDek(options.dek);
  const iv = randomBytes(IV_LENGTH);
  const ciphertext = await aesEncrypt(
    dekKey,
    iv,
    utf8ToBytes(options.plaintext),
    dataAad(options.revision),
  );
  const verifier = await computeVerifier(options.dek);
  return {
    data: { iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertext) },
    verifier: bytesToBase64(verifier),
  };
}

/** 既存封筒の revision を進めてデータを再暗号化する（DEK はアンロック中のメモリにある）。 */
export async function updateEnvelopeData(
  envelope: VaultEnvelope,
  dek: Uint8Array,
  plaintext: string,
  revision: number,
  updatedAt: string,
): Promise<VaultEnvelope> {
  const dekKey = await importDek(dek);
  const dataIv = randomBytes(IV_LENGTH);
  const ciphertext = await aesEncrypt(dekKey, dataIv, utf8ToBytes(plaintext), dataAad(revision));
  return {
    ...envelope,
    data: { iv: bytesToBase64(dataIv), ciphertext: bytesToBase64(ciphertext) },
    verifier: bytesToBase64(await computeVerifier(dek)),
    revision,
    updatedAt,
  };
}

/** パスワード変更: 同じ DEK を新しいパスワードの KEK でラップし直す。 */
export async function rewrapEnvelope(
  envelope: VaultEnvelope,
  dek: Uint8Array,
  newPassword: string,
  options: { iterations?: number; updatedAt?: string } = {},
): Promise<VaultEnvelope> {
  const iterations = options.iterations ?? envelope.kdf.iterations;
  const salt = randomBytes(SALT_LENGTH);
  const kek = await deriveKek(newPassword, salt, iterations);
  const wrapIv = randomBytes(IV_LENGTH);
  const wrappedKey = await aesEncrypt(kek, wrapIv, dek, WRAP_AAD);
  return {
    ...envelope,
    kdf: { name: 'PBKDF2-SHA256', iterations, salt: bytesToBase64(salt) },
    wrappedKey: { iv: bytesToBase64(wrapIv), ciphertext: bytesToBase64(wrappedKey) },
    updatedAt: options.updatedAt ?? new Date().toISOString(),
  };
}

/**
 * アンロック中の DEK でデータ部だけを復号する（パスワード不要）。
 * 同じボルト由来の封筒（同じ DEK）にのみ使える。
 */
export async function decryptVaultDataWithDek(envelope: VaultEnvelope, dek: Uint8Array): Promise<string> {
  const expected = base64ToBytes(envelope.verifier);
  const actual = await computeVerifier(dek);
  if (!timingSafeEqual(expected, actual)) {
    throw new CryptoError('この封筒は別の鍵で暗号化されています');
  }
  const dekKey = await importDek(dek);
  const plaintext = await aesDecrypt(
    dekKey,
    base64ToBytes(envelope.data.iv),
    base64ToBytes(envelope.data.ciphertext),
    dataAad(envelope.revision),
  );
  return bytesToUtf8(plaintext);
}

/** パスワード検証だけを行う（データ復号はしない）。 */
export async function verifyPassword(envelope: VaultEnvelope, password: string): Promise<boolean> {
  try {
    await unlockVaultEnvelope(envelope, password);
    return true;
  } catch {
    return false;
  }
}

/** 封筒の構造検証（サーバー側 zod と同程度の最低限）。 */
export function isVaultEnvelopeShape(value: unknown): value is VaultEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.format !== 'aegis-vault' || v.version !== 1) return false;
  const isCipher = (c: unknown): boolean =>
    typeof c === 'object' && c !== null && typeof (c as VaultCipher).iv === 'string' && typeof (c as VaultCipher).ciphertext === 'string';
  const kdf = v.kdf as VaultKdf | undefined;
  if (typeof kdf !== 'object' || kdf === null) return false;
  if (kdf.name !== 'PBKDF2-SHA256' || typeof kdf.iterations !== 'number' || typeof kdf.salt !== 'string') return false;
  return (
    isCipher(v.wrappedKey) &&
    isCipher(v.data) &&
    typeof v.verifier === 'string' &&
    typeof v.revision === 'number' &&
    typeof v.updatedAt === 'string'
  );
}
