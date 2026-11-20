/**
 * パスキー / セキュリティキー（WebAuthn PRF 拡張）によるロック解除のうち、
 * DOM に依存しない純粋な部分。
 *
 * 設計:
 * - PRF 出力（32B）を HKDF-SHA-256 で AES-256-GCM の KEK に変換する。
 *   入力（PRF 出力）は認証器の中から出てこない値で、端末のメモリにしか置かない。
 * - その KEK で既存の DEK をラップする（`wrappedDek`）。マスターパスワードの
 *   `wrappedKey` とは別の AAD（`aegis-passkey-v1`）を使い、取り違えを検出する。
 * - サーバー側の認証テーブルやチャレンジ検証は持たない。サーバーには今までどおり
 *   暗号文だけを置くため、Node 版でも Xserver PHP 版でもそのまま動く。
 * - 登録（credentialId・salt・wrappedDek・表示名・ボルト指紋・verifier）は端末の
 *   IndexedDB にだけ保存する（`src/lib/storage.ts`）。
 */

import { base64ToBytes, bytesToBase64, randomBytes, timingSafeEqualString, utf8ToBytes } from './encoding';
import type { PasskeyRecord, VaultCipher, VaultEnvelope } from './types';

/** DOM と Node の両方の型定義で通用する CryptoKey エイリアス。 */
type CryptoKeyLike = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;

/** PRF の eval に渡す salt の長さ（バイト）。 */
export const PRF_SALT_LENGTH = 32;
/** HKDF の info。用途の分離に使う。 */
export const PASSKEY_HKDF_INFO = 'aegis-passkey-kek-v1';
/** DEK のラップに使う AAD。パスワード側（aegis-vault-v1）と取り違えない。 */
const PASSKEY_WRAP_AAD = utf8ToBytes('aegis-passkey-v1');
/** PRF 出力として要求する最低長（HKDF の入力）。 */
const MIN_PRF_OUTPUT_LENGTH = 32;
/** HKDF の salt に要求する最低長。 */
const MIN_SALT_LENGTH = 16;
const DEK_LENGTH = 32;
const IV_LENGTH = 12;

export class PasskeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasskeyError';
  }
}

/** 保存済みの情報では DEK を取り出せない（別ボルト・PRF 出力の食い違い・改ざん）。 */
export class PasskeyMismatchError extends PasskeyError {
  constructor() {
    super('このパスキーではこのボルトを解除できません');
    this.name = 'PasskeyMismatchError';
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/** PRF の eval 用 salt を新しく作る。 */
export function generatePrfSalt(): Uint8Array {
  return randomBytes(PRF_SALT_LENGTH);
}

/**
 * HKDF-SHA-256(PRF 出力, salt) から AES-256-GCM の KEK を導出する。
 * PRF 出力は 32B 固定だが、実装差に備えて 32B 以上を受け付ける。
 */
export async function derivePasskeyKek(prfOutput: Uint8Array, prfSalt: Uint8Array): Promise<CryptoKeyLike> {
  if (prfOutput.length < MIN_PRF_OUTPUT_LENGTH) throw new PasskeyError('PRF の出力が短すぎます');
  if (prfSalt.length < MIN_SALT_LENGTH) throw new PasskeyError('PRF の salt が短すぎます');
  const baseKey = await globalThis.crypto.subtle.importKey('raw', toArrayBuffer(prfOutput), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(prfSalt),
      info: toArrayBuffer(utf8ToBytes(PASSKEY_HKDF_INFO)),
    },
    baseKey,
    256,
  );
  return globalThis.crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** パスキー用の KEK で DEK をラップする。 */
export async function wrapDekForPasskey(dek: Uint8Array, kek: CryptoKeyLike): Promise<VaultCipher> {
  if (dek.length !== DEK_LENGTH) throw new PasskeyError('DEK の長さが不正です');
  const iv = randomBytes(IV_LENGTH);
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(PASSKEY_WRAP_AAD) },
    kek,
    toArrayBuffer(dek),
  );
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

/** パスキー用の KEK で DEK をアンラップする。失敗は PasskeyMismatchError。 */
export async function unwrapDekForPasskey(wrapped: VaultCipher, kek: CryptoKeyLike): Promise<Uint8Array> {
  try {
    const plaintext = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(base64ToBytes(wrapped.iv)),
        additionalData: toArrayBuffer(PASSKEY_WRAP_AAD),
      },
      kek,
      toArrayBuffer(base64ToBytes(wrapped.ciphertext)),
    );
    const dek = new Uint8Array(plaintext);
    if (dek.length !== DEK_LENGTH) throw new PasskeyMismatchError();
    return dek;
  } catch (error) {
    if (error instanceof PasskeyMismatchError) throw error;
    throw new PasskeyMismatchError();
  }
}

/**
 * WebAuthn の user.id（認証器に保存される利用者ハンドル）。ボルトごとに安定させる。
 * verifier はすでに封筒に入っている値なので、ここから作っても新しい情報は漏れない。
 */
export async function passkeyUserId(verifier: string): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    toArrayBuffer(utf8ToBytes(`aegis-passkey-user-v1:${verifier}`)),
  );
  return new Uint8Array(digest).slice(0, 16);
}

/** 保存レコードの形を検査する（IndexedDB 由来の値は信用しない）。 */
export function isValidPasskeyRecord(value: unknown): value is PasskeyRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<PasskeyRecord>;
  if (record.v !== 1) return false;
  if (typeof record.id !== 'string' || record.id === '') return false;
  if (typeof record.name !== 'string') return false;
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) return false;
  if (typeof record.prfSalt !== 'string' || record.prfSalt === '') return false;
  if (typeof record.vaultFingerprint !== 'string') return false;
  if (typeof record.verifier !== 'string' || record.verifier === '') return false;
  const wrapped = record.wrappedDek as VaultCipher | undefined;
  if (typeof wrapped !== 'object' || wrapped === null) return false;
  if (typeof wrapped.iv !== 'string' || typeof wrapped.ciphertext !== 'string') return false;
  if (record.transports !== undefined) {
    if (!Array.isArray(record.transports)) return false;
    if (record.transports.some((item) => typeof item !== 'string')) return false;
  }
  // salt は base64 として読めなければならない（復号はしない）。
  try {
    if (base64ToBytes(record.prfSalt).length < MIN_SALT_LENGTH) return false;
    base64ToBytes(wrapped.iv);
    base64ToBytes(wrapped.ciphertext);
  } catch {
    return false;
  }
  return true;
}

/**
 * その封筒（＝その DEK）で使えるパスキーだけを残す。
 * ボルトの置き換え・取り込みで DEK が変わった場合、古い登録はここで落ちる。
 */
export function validPasskeysForEnvelope(
  records: readonly PasskeyRecord[],
  envelope: VaultEnvelope,
): PasskeyRecord[] {
  return records.filter(
    (record) => isValidPasskeyRecord(record) && timingSafeEqualString(record.verifier, envelope.verifier),
  );
}

/**
 * DEK が同じまま封筒だけが変わった（パスワード変更など）場合に、
 * 保存している指紋を今の封筒へ付け替える。値が同じレコードはそのまま返す。
 */
export function bindPasskeysToFingerprint(
  records: readonly PasskeyRecord[],
  fingerprint: string,
): PasskeyRecord[] {
  return records.map((record) =>
    record.vaultFingerprint === fingerprint ? record : { ...record, vaultFingerprint: fingerprint },
  );
}

/** レコードが今の封筒に登録されたものか（表示・診断用）。 */
export function isPasskeyBoundTo(record: PasskeyRecord, fingerprint: string): boolean {
  return record.vaultFingerprint === fingerprint;
}
