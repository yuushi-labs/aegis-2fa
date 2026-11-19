/**
 * Google Authenticator 移行 URI（otpauth-migration://offline?data=<base64url>）の
 * Protobuf デコーダ。依存追加なしの最小実装。
 *
 * MigrationPayload { repeated OtpParameters otp_parameters = 1; int32 version = 2;
 *                    int32 batch_size = 3; int32 batch_index = 4; int32 batch_id = 5; }
 * OtpParameters { bytes secret = 1; string name = 2; string issuer = 3;
 *                 Algorithm algorithm = 4; DigitCount digits = 5; OtpType type = 6; int64 counter = 7; }
 */

import { base64UrlToBytes, bytesToBase64Url, utf8ToBytes } from './encoding';
import { decodeBase32 } from './base32';
import type { Account, OtpAlgorithm } from './types';

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

const enum WireType {
  Varint = 0,
  Fixed64 = 1,
  LengthDelimited = 2,
  StartGroup = 3,
  EndGroup = 4,
  Fixed32 = 5,
}

const ALGORITHM_BY_ENUM: Record<number, OtpAlgorithm> = {
  1: 'SHA1',
  2: 'SHA256',
  3: 'SHA512',
};

const DIGITS_BY_ENUM: Record<number, 6 | 8> = {
  1: 6,
  2: 8,
};

const TYPE_BY_ENUM: Record<number, 'hotp' | 'totp'> = {
  1: 'hotp',
  2: 'totp',
};

export type MigrationEntry = {
  secret: string;
  name: string;
  issuer: string;
  algorithm: OtpAlgorithm;
  digits: 6 | 8;
  type: 'hotp' | 'totp';
  counter: number;
  /** TOTP の周期（移行形式には保存できない。既定 30） */
  period?: number;
};

/** 移行形式（otpauth-migration）が表現できる TOTP の周期。 */
export const MIGRATION_TOTP_PERIOD = 30;

/** この TOTP 周期を移行 QR で表現できるか。 */
export function isMigrationRepresentable(
  entry: Pick<MigrationEntry, 'type' | 'period'>,
): boolean {
  if (entry.type !== 'totp') return true;
  return (entry.period ?? MIGRATION_TOTP_PERIOD) === MIGRATION_TOTP_PERIOD;
}

export type MigrationResult = {
  entries: MigrationEntry[];
  skipped: number;
  skipReasons: string[];
  version: number;
  batchSize: number;
  batchIndex: number;
  batchId: number;
};

type Field = { fieldNumber: number; wireType: WireType; value: Uint8Array | number | bigint };

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  /** 64bit までの可変長整数を bigint で読む（符号拡張された int32 も壊さない）。 */
  readVarintBig(): bigint {
    let result = 0n;
    let shift = 0n;
    let byteCount = 0;
    while (true) {
      if (this.offset >= this.bytes.length) {
        throw new MigrationError('Protobuf の可変長整数が途中で終わっています');
      }
      const byte = this.bytes[this.offset++] as number;
      byteCount += 1;
      // 10 バイト目は 64bit の最上位ビットしか持てない（0x81 等は 64bit 超過）。
      if (byteCount === 10 && (byte & 0x7f) > 1) {
        throw new MigrationError('可変長整数が大きすぎます');
      }
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
      if (shift > 63n) throw new MigrationError('可変長整数が大きすぎます');
    }
    return result;
  }

  readVarint(): number {
    const value = this.readVarintBig();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new MigrationError('可変長整数が安全な整数の範囲を超えています');
    }
    return Number(value);
  }

  readBytes(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) {
      throw new MigrationError('Protobuf の長さ指定が範囲外です');
    }
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  readFixed(length: number): number {
    const slice = this.readBytes(length);
    let value = 0;
    for (let i = 0; i < length; i += 1) {
      value += (slice[i] as number) * 2 ** (8 * i);
    }
    return value;
  }

  readTag(): { fieldNumber: number; wireType: WireType } {
    const tag = this.readVarint();
    const fieldNumber = Math.floor(tag / 8);
    const wireType = (tag % 8) as WireType;
    if (fieldNumber === 0) throw new MigrationError('フィールド番号 0 は不正です');
    return { fieldNumber, wireType };
  }

  skip(wireType: WireType): void {
    switch (wireType) {
      case WireType.Varint:
        this.readVarint();
        return;
      case WireType.Fixed64:
        this.readBytes(8);
        return;
      case WireType.LengthDelimited:
        this.readBytes(this.readVarint());
        return;
      case WireType.Fixed32:
        this.readBytes(4);
        return;
      default:
        throw new MigrationError(`未対応の wire type です: ${wireType}`);
    }
  }
}

function readFields(bytes: Uint8Array): Field[] {
  const reader = new Reader(bytes);
  const fields: Field[] = [];
  while (!reader.done) {
    const { fieldNumber, wireType } = reader.readTag();
    if (wireType === WireType.Varint) {
      const raw = reader.readVarintBig();
      // 安全整数に収まる値は number、収まらない値（符号拡張された int32 など）は bigint で保持する。
      fields.push({
        fieldNumber,
        wireType,
        value: raw <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) : raw,
      });
    } else if (wireType === WireType.LengthDelimited) {
      fields.push({ fieldNumber, wireType, value: reader.readBytes(reader.readVarint()) });
    } else if (wireType === WireType.Fixed32) {
      fields.push({ fieldNumber, wireType, value: reader.readFixed(4) });
    } else if (wireType === WireType.Fixed64) {
      fields.push({ fieldNumber, wireType, value: reader.readFixed(8) });
    } else {
      throw new MigrationError(`未対応の wire type です: ${wireType}`);
    }
  }
  return fields;
}


/** 宣言が int32 のフィールドを符号付き 32bit として解釈する（負の値は 10 バイトの varint になる）。 */
function asInt32(field: Field | undefined): number {
  if (field === undefined) return 0;
  if (typeof field.value === 'number') {
    return field.value > 0x7fffffff ? Number(BigInt.asIntN(32, BigInt(field.value))) : field.value;
  }
  if (typeof field.value === 'bigint') return Number(BigInt.asIntN(32, field.value));
  return 0;
}

/** 宣言が int64 のフィールドを符号付きとして解釈する。安全整数に収まらない場合は null。 */
function asInt64(field: Field | undefined): number | null {
  if (field === undefined) return 0;
  if (typeof field.value === 'number') return Number.isSafeInteger(field.value) ? field.value : null;
  if (typeof field.value === 'bigint') {
    const signed = BigInt.asIntN(64, field.value);
    if (signed < BigInt(Number.MIN_SAFE_INTEGER) || signed > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(signed);
  }
  return null;
}

function asBytes(field: Field | undefined): Uint8Array | null {
  if (field === undefined) return null;
  return field.value instanceof Uint8Array ? field.value : null;
}

function asString(field: Field | undefined): string {
  const bytes = asBytes(field);
  if (bytes === null) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new MigrationError('Protobuf の文字列が UTF-8 ではありません');
  }
}

export function decodeOtpParameters(bytes: Uint8Array): { entry: MigrationEntry | null; reason: string | null } {
  const fields = readFields(bytes);
  const last = (n: number) => fields.filter((f) => f.fieldNumber === n).at(-1);

  const secretBytes = asBytes(last(1));
  if (secretBytes === null || secretBytes.length === 0) {
    return { entry: null, reason: '秘密鍵が空です' };
  }
  const secret = toBase32(secretBytes);

  const algorithmEnum = asInt32(last(4));
  const digitsEnum = asInt32(last(5));
  const typeEnum = asInt32(last(6));
  const counterValue = asInt64(last(7));
  if (counterValue === null || counterValue < 0) {
    return { entry: null, reason: 'HOTP のカウンタが不正です' };
  }
  const counter = counterValue;

  if (algorithmEnum === 4) {
    return { entry: null, reason: 'MD5 は未対応です' };
  }
  const algorithm = ALGORITHM_BY_ENUM[algorithmEnum];
  if (algorithm === undefined) {
    return { entry: null, reason: `不明なアルゴリズムです (${algorithmEnum})` };
  }
  const digits = DIGITS_BY_ENUM[digitsEnum];
  if (digits === undefined) {
    return { entry: null, reason: `不明な桁数です (${digitsEnum})` };
  }
  const type = TYPE_BY_ENUM[typeEnum];
  if (type === undefined) {
    return { entry: null, reason: `不明な種別です (${typeEnum})` };
  }

  return {
    entry: {
      secret,
      name: asString(last(2)),
      issuer: asString(last(3)),
      algorithm,
      digits,
      type,
      counter: type === 'hotp' ? counter : 0,
    },
    reason: null,
  };
}

/** バイト列 → Base32（パディング無し）。base32.encode と同等だが循環回避のため局所実装。 */
function toBase32(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

export function decodeMigrationPayload(data: Uint8Array): MigrationResult {
  const fields = readFields(data);
  const last = (n: number) => fields.filter((f) => f.fieldNumber === n).at(-1);

  const entries: MigrationEntry[] = [];
  const skipReasons: string[] = [];
  for (const field of fields) {
    if (field.fieldNumber !== 1 || !(field.value instanceof Uint8Array)) continue;
    const { entry, reason } = decodeOtpParameters(field.value);
    if (entry !== null) {
      entries.push(entry);
    } else {
      skipReasons.push(reason ?? '不明な理由');
    }
  }

  return {
    entries,
    skipped: skipReasons.length,
    skipReasons,
    version: asInt32(last(2)),
    batchSize: asInt32(last(3)),
    batchIndex: asInt32(last(4)),
    batchId: asInt32(last(5)),
  };
}

/** otpauth-migration://offline?data=... をデコードする。 */
export function parseMigrationUri(uri: string): MigrationResult {
  const trimmed = uri.trim();
  if (!/^otpauth-migration:\/\//i.test(trimmed)) {
    throw new MigrationError('otpauth-migration:// ではありません');
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new MigrationError('移行 URI として解釈できません');
  }
  const data = url.searchParams.get('data');
  if (data === null || data.trim() === '') {
    throw new MigrationError('data パラメータがありません');
  }
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(data);
  } catch {
    throw new MigrationError('data が base64url として不正です');
  }
  if (bytes.length === 0) {
    throw new MigrationError('data が空です');
  }
  try {
    const result = decodeMigrationPayload(bytes);
    if (result.entries.length === 0 && result.skipped === 0) {
      throw new MigrationError('移行データにアカウントが含まれていません');
    }
    return result;
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError('この QR は読み取れませんでした');
  }
}

/** 移行エントリを Account の下書きへ変換する。 */
export function migrationEntryToAccount(
  entry: MigrationEntry,
  id: string,
  now: string,
  order: number,
): Account {
  const colonIndex = entry.name.indexOf(':');
  const nameIssuer = colonIndex === -1 ? '' : entry.name.slice(0, colonIndex).trim();
  const nameLabel = colonIndex === -1 ? entry.name : entry.name.slice(colonIndex + 1).trim();
  const issuer = entry.issuer !== '' ? entry.issuer : nameIssuer;
  // issuer が分かっている場合は、その接頭辞（"Issuer:"）だけを 1 回外す。
  const prefix = entry.issuer !== '' ? `${entry.issuer}:` : '';
  const stripPrefix =
    entry.issuer !== ''
      ? entry.name.startsWith(prefix)
      : colonIndex !== -1 && nameIssuer !== '';
  const label = stripPrefix
    ? (entry.issuer !== '' ? entry.name.slice(prefix.length) : nameLabel) || entry.name
    : entry.name;
  return {
    id,
    type: entry.type,
    issuer,
    label: label === '' ? 'アカウント' : label,
    secret: entry.secret,
    algorithm: entry.algorithm,
    digits: entry.digits,
    period: 30,
    counter: entry.counter,
    pinned: false,
    order,
    createdAt: now,
    updatedAt: now,
  };
}

const ALGORITHM_TO_ENUM: Record<OtpAlgorithm, number> = {
  SHA1: 1,
  SHA256: 2,
  SHA512: 3,
};

const DIGITS_TO_ENUM: Record<6 | 8, number> = { 6: 1, 8: 2 };

const TYPE_TO_ENUM: Record<'hotp' | 'totp', number> = { hotp: 1, totp: 2 };

function writeVarint(value: number): number[] {
  if (!Number.isInteger(value) || value < 0) throw new MigrationError('varint は非負整数のみです');
  const out: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}

function writeTag(fieldNumber: number, wireType: number): number[] {
  return writeVarint(fieldNumber * 8 + wireType);
}

function writeLengthDelimited(fieldNumber: number, payload: Uint8Array): number[] {
  return [...writeTag(fieldNumber, WireType.LengthDelimited), ...writeVarint(payload.length), ...payload];
}

function writeVarintField(fieldNumber: number, value: number): number[] {
  return [...writeTag(fieldNumber, WireType.Varint), ...writeVarint(value)];
}

/**
 * 移行形式の name は「Issuer:account」。取込側はこの接頭辞を 1 回だけ外すので、
 * 出力側も常に 1 回付ける（ラベル自体が "Issuer:" で始まる場合も往復で失われない）。
 */
export function qualifiedEntryName(issuer: string, name: string): string {
  if (issuer === '' || name === '') return name;
  return `${issuer}:${name}`;
}

/**
 * アカウント群を otpauth-migration:// URI にエンコードする。
 * Google Authenticator の「QR を読み取る」でそのまま取り込める。
 */
export function encodeMigrationPayload(entries: readonly MigrationEntry[]): string {
  for (const entry of entries) {
    // 移行形式は周期を持たないため、30 秒以外の TOTP は黙って変換しない。
    if (entry.type === 'totp' && !isMigrationRepresentable(entry)) {
      throw new MigrationError('30 秒以外の TOTP は移行 QR にまとめられません');
    }
  }
  const body: number[] = [];
  for (const entry of entries) {
    const secret = decodeBase32(entry.secret);
    const params: number[] = [...writeLengthDelimited(1, secret)];
    const qualifiedName = qualifiedEntryName(entry.issuer, entry.name);
    if (qualifiedName !== '') params.push(...writeLengthDelimited(2, utf8ToBytes(qualifiedName)));
    if (entry.issuer !== '') params.push(...writeLengthDelimited(3, utf8ToBytes(entry.issuer)));
    params.push(...writeVarintField(4, ALGORITHM_TO_ENUM[entry.algorithm]));
    params.push(...writeVarintField(5, DIGITS_TO_ENUM[entry.digits]));
    params.push(...writeVarintField(6, TYPE_TO_ENUM[entry.type]));
    if (entry.type === 'hotp') params.push(...writeVarintField(7, entry.counter));
    body.push(...writeLengthDelimited(1, Uint8Array.from(params)));
  }
  body.push(...writeVarintField(2, 1));
  // batch_size は「分割された QR の総数」。1 つの URI にまとめるので常に 1。
  body.push(...writeVarintField(3, 1));
  body.push(...writeVarintField(4, 0));
  body.push(...writeVarintField(5, 0));
  const encoded = bytesToBase64Url(Uint8Array.from(body));
  return `otpauth-migration://offline?data=${encodeURIComponent(encoded)}`;
}

/** テスト用: バイト列が正しい Base32 として解釈できることを検証する。 */
export function isDecodableSecret(secret: string): boolean {
  try {
    decodeBase32(secret);
    return true;
  } catch {
    return false;
  }
}

/**
 * アカウントを「移行 QR にまとめられるもの」と「周期を保てないもの」に分ける。
 * 30 秒以外の TOTP はそのまま変換すると値が変わってしまうため、個別の otpauth URI へ誘導する。
 */
export function partitionMigratableAccounts(accounts: readonly Account[]): {
  entries: MigrationEntry[];
  unsupported: Account[];
} {
  const entries: MigrationEntry[] = [];
  const unsupported: Account[] = [];
  for (const account of accounts) {
    const entry: MigrationEntry = {
      secret: account.secret,
      name: account.label,
      issuer: account.issuer,
      algorithm: account.algorithm,
      digits: account.digits,
      type: account.type,
      counter: account.counter,
      period: account.period,
    };
    if (isMigrationRepresentable(entry)) entries.push(entry);
    else unsupported.push(account);
  }
  return { entries, unsupported };
}
