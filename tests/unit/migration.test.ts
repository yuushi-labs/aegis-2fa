import { describe, expect, it } from 'vitest';
import {
  MigrationError,
  decodeMigrationPayload,
  encodeMigrationPayload,
  migrationEntryToAccount,
  parseMigrationUri,
  partitionMigratableAccounts,
} from '../../shared/migration';
import type { Account } from '../../shared/types';
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

/** 64bit の varint（負の int32 は符号拡張された 10 バイトになる）。 */
function varintBig(value: bigint): number[] {
  const out: number[] = [];
  let rest = BigInt.asUintN(64, value);
  while (rest > 0x7fn) {
    out.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  out.push(Number(rest));
  return out;
}

function varintFieldBig(fieldNumber: number, value: bigint): number[] {
  return [...tag(fieldNumber, 0), ...varintBig(value)];
}

function makeAccount(overrides: Partial<Account> & { id: string }): Account {
  return {
    type: 'totp',
    issuer: 'Example',
    label: `${overrides.id}@example.com`,
    secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    counter: 0,
    pinned: false,
    order: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
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

  it('負の int32（batch_id=-1）でも取り込み全体が失敗しない', () => {
    // Protobuf の int32 負数は符号拡張された 10 バイトの varint。
    const bytes = payload([TOTP_ENTRY], [...varintFieldBig(2, 1n), ...varintFieldBig(5, -1n)]);
    const result = decodeMigrationPayload(bytes);
    expect(result.batchId).toBe(-1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe('alice@example.com');
  });

  it('安全整数を超える HOTP counter はその 1 件だけスキップする', () => {
    const hugeCounter = otpParameters({
      secret: SECRET_C,
      name: 'huge@example.com',
      issuer: 'Legacy',
      algorithm: 1,
      digits: 1,
      type: 1,
    });
    const bytes = payload([TOTP_ENTRY], [...lenDelimited(1, [...hugeCounter, ...varintFieldBig(7, 2n ** 60n)])]);
    // 上の payload は field 1 を 2 つ持つので、huge な counter 側だけが skip される。
    const result = decodeMigrationPayload(bytes);
    expect(result.entries.some((entry) => entry.name === 'alice@example.com')).toBe(true);
    expect(result.skipped).toBe(1);
    expect(result.skipReasons[0]).toContain('カウンタ');
  });

  it('負の HOTP counter はスキップする', () => {
    const bytes = payload([TOTP_ENTRY], [...lenDelimited(1, [...HOTP_ENTRY, ...varintFieldBig(7, -5n)])]);
    const result = decodeMigrationPayload(bytes);
    expect(result.skipped).toBe(1);
    expect(result.skipReasons[0]).toContain('カウンタ');
    expect(result.entries).toHaveLength(1);
  });

  it('エンコードした単一 URI の batch_size は 1', () => {
    const uri = encodeMigrationPayload([
      { secret: 'JBSWY3DPEHPK3PXP', name: 'a', issuer: 'I', algorithm: 'SHA1', digits: 6, type: 'totp', counter: 0 },
      { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', name: 'b', issuer: 'I', algorithm: 'SHA1', digits: 6, type: 'totp', counter: 0 },
    ]);
    const result = parseMigrationUri(uri);
    expect(result.batchSize).toBe(1);
    expect(result.batchIndex).toBe(0);
    expect(result.entries).toHaveLength(2);
  });

  it('30 秒以外の TOTP は黙って変換せず、出力を拒否する', () => {
    const sixty = { secret: 'JBSWY3DPEHPK3PXP', name: 'p60', issuer: 'I', algorithm: 'SHA1' as const, digits: 6 as const, type: 'totp' as const, counter: 0, period: 60 };
    expect(() => encodeMigrationPayload([sixty])).toThrow(MigrationError);
    // 30 秒の TOTP と HOTP はそのまま出力できる。
    expect(() =>
      encodeMigrationPayload([{ ...sixty, period: 30 }]),
    ).not.toThrow();
    expect(() =>
      encodeMigrationPayload([{ ...sixty, type: 'hotp', counter: 3 }]),
    ).not.toThrow();
  });

  it('partitionMigratableAccounts が周期を保てないものだけを分ける', () => {
    const accounts = [
      makeAccount({ id: 'a', type: 'totp', period: 30 }),
      makeAccount({ id: 'b', type: 'totp', period: 60 }),
      makeAccount({ id: 'c', type: 'hotp', counter: 4 }),
    ];
    const { entries, unsupported } = partitionMigratableAccounts(accounts);
    expect(entries.map((entry) => entry.name)).toEqual(['a@example.com', 'c@example.com']);
    expect(unsupported.map((account) => account.id)).toEqual(['b']);
    expect(entries[1]?.counter).toBe(4);
  });

  it('エクスポート→インポートで issuer/label が往復する（接頭辞を含むラベルも）', () => {
    const cases = [
      { issuer: 'Example', label: 'alice@example.com' },
      { issuer: 'Example', label: 'Example:alice@example.com' },
      { issuer: '', label: 'plain@example.com' },
    ];
    for (const item of cases) {
      const uri = encodeMigrationPayload([
        { secret: 'JBSWY3DPEHPK3PXP', name: item.label, issuer: item.issuer, algorithm: 'SHA1', digits: 6, type: 'totp', counter: 0 },
      ]);
      const parsed = parseMigrationUri(uri);
      const entry = parsed.entries[0];
      expect(entry).toBeDefined();
      const account = migrationEntryToAccount(entry!, 'id', '2024-01-01T00:00:00.000Z', 0);
      expect(account.issuer).toBe(item.issuer);
      expect(account.label).toBe(item.label);
    }
  });

  it('10 バイト目のペイロードが 2 以上の varint は拒否する', () => {
    // 0x81 + 0x80 * 8 + 0x02 は 2^64 + 1（64bit 超過）。
    const bytes = payload([TOTP_ENTRY], [...tag(5, 0), 0x81, ...Array(8).fill(0x80), 0x02]);
    expect(() => decodeMigrationPayload(bytes)).toThrow(MigrationError);
  });

  it('安全整数を超える fixed64 の counter はスキップする', () => {
    const fixed64Tag = [...tag(7, 1), ...Array(8).fill(0xff)];
    const bytes = payload([TOTP_ENTRY], [...lenDelimited(1, [...HOTP_ENTRY, ...fixed64Tag])]);
    const result = decodeMigrationPayload(bytes);
    expect(result.skipped).toBe(1);
    expect(result.skipReasons[0]).toContain('カウンタ');
    expect(result.entries).toHaveLength(1);
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
