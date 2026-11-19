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
};

export type MigrationResult = {
  entries: MigrationEntry[];
  skipped: number;
  skipReasons: string[];
  version: number;
  batchSize: number;
  batchIndex: number;
  batchId: number;
};

type Field = { fieldNumber: number; wireType: WireType; value: Uint8Array | number };

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  readVarint(): number {
    let result = 0;
    let shift = 0;
    while (true) {
      if (this.offset >= this.bytes.length) {
        throw new MigrationError('Protobuf の可変長整数が途中で終わっています');
      }
      const byte = this.bytes[this.offset++] as number;
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 63) throw new MigrationError('可変長整数が大きすぎます');
    }
    if (!Number.isSafeInteger(result)) {
      throw new MigrationError('可変長整数が安全な整数の範囲を超えています');
    }
    return result;
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
      fields.push({ fieldNumber, wireType, value: reader.readVarint() });
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

function asNumber(field: Field | undefined): number {
  return field !== undefined && typeof field.value === 'number' ? field.value : 0;
}

function asBytes(field: Field | undefined): Uint8Array | null {
  return field !== undefined && typeof field.value !== 'number' ? field.value : null;
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

  const algorithmEnum = asNumber(last(4));
  const digitsEnum = asNumber(last(5));
  const typeEnum = asNumber(last(6));
  const counter = asNumber(last(7));

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
    if (field.fieldNumber !== 1 || typeof field.value === 'number') continue;
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
    version: asNumber(last(2)),
    batchSize: asNumber(last(3)),
    batchIndex: asNumber(last(4)),
    batchId: asNumber(last(5)),
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
  const stripPrefix =
    colonIndex !== -1 && (entry.issuer === '' || nameIssuer.toLowerCase() === entry.issuer.toLowerCase());
  const label = stripPrefix ? nameLabel || entry.name : entry.name;
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
 * アカウント群を otpauth-migration:// URI にエンコードする。
 * Google Authenticator の「QR を読み取る」でそのまま取り込める。
 */
export function encodeMigrationPayload(entries: readonly MigrationEntry[]): string {
  const body: number[] = [];
  for (const entry of entries) {
    const secret = decodeBase32(entry.secret);
    const params: number[] = [...writeLengthDelimited(1, secret)];
    if (entry.name !== '') params.push(...writeLengthDelimited(2, utf8ToBytes(entry.name)));
    if (entry.issuer !== '') params.push(...writeLengthDelimited(3, utf8ToBytes(entry.issuer)));
    params.push(...writeVarintField(4, ALGORITHM_TO_ENUM[entry.algorithm]));
    params.push(...writeVarintField(5, DIGITS_TO_ENUM[entry.digits]));
    params.push(...writeVarintField(6, TYPE_TO_ENUM[entry.type]));
    if (entry.type === 'hotp') params.push(...writeVarintField(7, entry.counter));
    body.push(...writeLengthDelimited(1, Uint8Array.from(params)));
  }
  body.push(...writeVarintField(2, 1));
  body.push(...writeVarintField(3, entries.length));
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
