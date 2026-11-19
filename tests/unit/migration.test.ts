import { describe, expect, it } from 'vitest';
import {
  MigrationError,
  decodeMigrationPayload,
  migrationEntryToAccount,
  parseMigrationUri,
} from '../../shared/migration';
import { bytesToBase64Url } from '../../shared/encoding';
import { decodeBase32 } from '../../shared/base32';

/** 最小の Protobuf エンコーダ（テスト用の手組みバイト列を作る）。 */
function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

function tag(fieldNumber: number, wireType: number): number[] {
  return varint(fieldNumber * 8 + wireType);
}

function lenDelimited(fieldNumber: number, payload: number[] | Uint8Array): number[] {
  const bytes = [...payload];
  return [...tag(fieldNumber, 2), ...varint(bytes.length), ...bytes];
}

function varintField(fieldNumber: number, value: number): number[] {
  return [...tag(fieldNumber, 0), ...varint(value)];
}

type OtpParamsInput = {
  secret: Uint8Array;
  name?: string;
  issuer?: string;
  algorithm?: number;
  digits?: number;
  type?: number;
  counter?: number;
};

function otpParameters(input: OtpParamsInput): number[] {
  const out: number[] = [];
  out.push(...lenDelimited(1, input.secret));
  if (input.name !== undefined) out.push(...lenDelimited(2, [...new TextEncoder().encode(input.name)]));
  if (input.issuer !== undefined) out.push(...lenDelimited(3, [...new TextEncoder().encode(input.issuer)]));
  if (input.algorithm !== undefined) out.push(...varintField(4, input.algorithm));
  if (input.digits !== undefined) out.push(...varintField(5, input.digits));
  if (input.type !== undefined) out.push(...varintField(6, input.type));
  if (input.counter !== undefined) out.push(...varintField(7, input.counter));
  return out;
}

function payload(entries: number[][], extra: number[] = []): Uint8Array {
  const out: number[] = [];
  for (const entry of entries) out.push(...lenDelimited(1, entry));
  out.push(...extra);
  return Uint8Array.from(out);
}

const SECRET_A = decodeBase32('JBSWY3DPEHPK3PXP');
const SECRET_B = decodeBase32('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
const SECRET_C = decodeBase32('MFRGGZDFMZTWQ2LK');

const TOTP_ENTRY = otpParameters({
  secret: SECRET_A,
  name: 'alice@example.com',
  issuer: 'Example',
  algorithm: 1,
  digits: 1,
  type: 2,
});
const TOTP_ENTRY_2 = otpParameters({
  secret: SECRET_B,
  name: 'bob@example.com',
  issuer: 'Example2',
  algorithm: 2,
  digits: 2,
  type: 2,
});
const HOTP_ENTRY = otpParameters({
  secret: SECRET_C,
  name: 'carol@example.com',
  issuer: 'Legacy',
  algorithm: 1,
  digits: 1,
  type: 1,
  counter: 12,
});
/** MD5（=4）は未対応としてスキップされる。 */
const MD5_ENTRY = otpParameters({
  secret: SECRET_A,
  name: 'md5@example.com',
  issuer: 'Old',
  algorithm: 4,
  digits: 1,
  type: 2,
});
/** 未知の enum（99）もスキップされる。 */
const UNKNOWN_ENUM_ENTRY = otpParameters({
  secret: SECRET_B,
  name: 'unknown@example.com',
  issuer: 'Weird',
  algorithm: 99,
  digits: 1,
  type: 2,
});

describe('Google Authenticator 移行形式', () => {
  it('TOTP 2 件 + HOTP 1 件 + 未知 2 件をデコードできる', () => {
    const bytes = payload([TOTP_ENTRY, TOTP_ENTRY_2, HOTP_ENTRY, MD5_ENTRY, UNKNOWN_ENUM_ENTRY], [
      ...varintField(2, 1),
      ...varintField(3, 5),
      ...varintField(4, 0),
      ...varintField(5, 12345),
    ]);
    const result = decodeMigrationPayload(bytes);
    expect(result.entries).toHaveLength(3);
    expect(result.skipped).toBe(2);
    expect(result.version).toBe(1);
    expect(result.batchSize).toBe(5);
    expect(result.batchIndex).toBe(0);
    expect(result.batchId).toBe(12345);

    expect(result.entries[0]).toEqual({
      secret: 'JBSWY3DPEHPK3PXP',
      name: 'alice@example.com',
      issuer: 'Example',
      algorithm: 'SHA1',
      digits: 6,
      type: 'totp',
      counter: 0,
    });
    expect(result.entries[1]?.algorithm).toBe('SHA256');
    expect(result.entries[1]?.digits).toBe(8);
    expect(result.entries[2]).toMatchObject({ type: 'hotp', counter: 12 });
  });

  it('base64url（パディング無し・パディング有り）どちらでも読める', () => {
    const bytes = payload([TOTP_ENTRY, TOTP_ENTRY_2]);
    const unpadded = bytesToBase64Url(bytes);
    const padded = `${unpadded}${'='.repeat((4 - (unpadded.length % 4)) % 4)}`;

    const fromUnpadded = parseMigrationUri(`otpauth-migration://offline?data=${unpadded}`);
    expect(fromUnpadded.entries).toHaveLength(2);

    const fromPadded = parseMigrationUri(`otpauth-migration://offline?data=${encodeURIComponent(padded)}`);
    expect(fromPadded.entries).toHaveLength(2);
  });

  it('data を URL エンコードしていても読める', () => {
    const bytes = payload([TOTP_ENTRY]);
    const encoded = encodeURIComponent(bytesToBase64Url(bytes));
    expect(parseMigrationUri(`otpauth-migration://offline?data=${encoded}`).entries).toHaveLength(1);
  });

  it.each([
    ['otpauth-migration://offline', 'data なし'],
    ['otpauth://totp/a?secret=JBSWY3DPEHPK3PXP', 'スキーム違い'],
    ['otpauth-migration://offline?data=!!!!', 'base64 不正'],
    ['otpauth-migration://offline?data=', 'data 空'],
  ])('壊れた入力は例外: %s', (uri) => {
    expect(() => parseMigrationUri(uri)).toThrow(MigrationError);
  });

  it('切り詰められた Protobuf は例外になる', () => {
    const bytes = payload([TOTP_ENTRY]);
    expect(() => decodeMigrationPayload(bytes.slice(0, 3))).toThrow(MigrationError);
  });

  it('アカウントは含まれるがすべてスキップされた場合も結果を返す', () => {
    const result = decodeMigrationPayload(payload([MD5_ENTRY]));
    expect(result.entries).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(result.skipReasons[0]).toContain('MD5');
  });

  it('migrationEntryToAccount が issuer/label を分離する', () => {
    const entry = {
      secret: 'JBSWY3DPEHPK3PXP',
      name: 'Example:alice@example.com',
      issuer: '',
      algorithm: 'SHA1' as const,
      digits: 6 as const,
      type: 'totp' as const,
      counter: 0,
    };
    const account = migrationEntryToAccount(entry, 'id-1', '2024-01-01T00:00:00.000Z', 3);
    expect(account.issuer).toBe('Example');
    expect(account.label).toBe('alice@example.com');
    expect(account.order).toBe(3);
  });
});
