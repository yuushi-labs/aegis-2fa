/**
 * パスキー / セキュリティキー（WebAuthn PRF）の純粋ロジックの単体テスト。
 *
 * 実際の認証器とのやりとりは E2E（仮想オーセンティケータ）で検証する。
 * ここでは「PRF 出力→KEK→DEK のラップ／アンラップ」と、
 * 「別ボルトに差し替わった登録をどう扱うか」を確かめる。
 */

import { describe, expect, it } from 'vitest';
import {
  PasskeyMismatchError,
  bindPasskeysToFingerprint,
  derivePasskeyKek,
  generatePrfSalt,
  isPasskeyBoundTo,
  isValidPasskeyRecord,
  passkeyUserId,
  unwrapDekForPasskey,
  validPasskeysForEnvelope,
  wrapDekForPasskey,
} from '../../shared/passkey';
import { bytesToBase64, randomBytes } from '../../shared/encoding';
import type { PasskeyRecord, VaultEnvelope } from '../../shared/types';

function envelope(overrides: Partial<VaultEnvelope> = {}): VaultEnvelope {
  return {
    format: 'aegis-vault',
    version: 1,
    kdf: { name: 'PBKDF2-SHA256', iterations: 600_000, salt: 'c2FsdA==' },
    wrappedKey: { iv: 'aXY=', ciphertext: 'd3JhcHBlZA==' },
    data: { iv: 'aXYy', ciphertext: 'ZGF0YQ==' },
    verifier: 'verifier-one',
    revision: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function record(overrides: Partial<PasskeyRecord> = {}): PasskeyRecord {
  return {
    v: 1,
    id: 'Y3JlZGVudGlhbC1pZA==',
    name: 'Pixel の指紋',
    createdAt: '2026-01-02T03:04:05.000Z',
    prfSalt: bytesToBase64(new Uint8Array(32).fill(7)),
    wrappedDek: { iv: bytesToBase64(new Uint8Array(12).fill(1)), ciphertext: 'd3JhcHBlZA==' },
    vaultFingerprint: 'fingerprint-one',
    verifier: 'verifier-one',
    transports: ['internal'],
    ...overrides,
  };
}

describe('PRF の salt', () => {
  it('32B の乱数を毎回作る', () => {
    const first = generatePrfSalt();
    const second = generatePrfSalt();
    expect(first).toHaveLength(32);
    expect(bytesToBase64(first)).not.toBe(bytesToBase64(second));
  });
});

describe('PRF 出力からの KEK 導出と DEK のラップ', () => {
  it('同じ PRF 出力と salt からは同じ鍵になり、DEK を往復できる', async () => {
    const prfOutput = new Uint8Array(32).fill(9);
    const salt = new Uint8Array(32).fill(3);
    const dek = randomBytes(32);

    const kekA = await derivePasskeyKek(prfOutput, salt);
    const kekB = await derivePasskeyKek(prfOutput, salt);
    const wrapped = await wrapDekForPasskey(dek, kekA);
    await expect(unwrapDekForPasskey(wrapped, kekB)).resolves.toEqual(dek);
  });

  it('salt が違えば DEK を取り出せない（PasskeyMismatchError）', async () => {
    const prfOutput = new Uint8Array(32).fill(9);
    const wrapped = await wrapDekForPasskey(randomBytes(32), await derivePasskeyKek(prfOutput, new Uint8Array(32).fill(3)));
    const otherKek = await derivePasskeyKek(prfOutput, new Uint8Array(32).fill(4));
    await expect(unwrapDekForPasskey(wrapped, otherKek)).rejects.toBeInstanceOf(PasskeyMismatchError);
  });

  it('暗号文を 1 バイト変えると復号に失敗する', async () => {
    const kek = await derivePasskeyKek(new Uint8Array(32).fill(9), new Uint8Array(32).fill(3));
    const wrapped = await wrapDekForPasskey(randomBytes(32), kek);
    const raw = Buffer.from(wrapped.ciphertext, 'base64');
    raw[0] = (raw[0] ?? 0) ^ 0xff;
    await expect(
      unwrapDekForPasskey({ ...wrapped, ciphertext: raw.toString('base64') }, kek),
    ).rejects.toBeInstanceOf(PasskeyMismatchError);
  });

  it('IV が毎回変わる（同じ DEK でも暗号文が一致しない）', async () => {
    const kek = await derivePasskeyKek(new Uint8Array(32).fill(9), new Uint8Array(32).fill(3));
    const dek = randomBytes(32);
    const first = await wrapDekForPasskey(dek, kek);
    const second = await wrapDekForPasskey(dek, kek);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('短すぎる PRF 出力・salt は受け付けない', async () => {
    await expect(derivePasskeyKek(new Uint8Array(16), new Uint8Array(32))).rejects.toThrow();
    await expect(derivePasskeyKek(new Uint8Array(32), new Uint8Array(8))).rejects.toThrow();
  });

  it('DEK の長さが不正ならラップしない', async () => {
    const kek = await derivePasskeyKek(new Uint8Array(32).fill(9), new Uint8Array(32).fill(3));
    await expect(wrapDekForPasskey(new Uint8Array(16), kek)).rejects.toThrow();
  });
});

describe('WebAuthn の user.id', () => {
  it('verifier ごとに決まった 16B になり、別のボルトでは変わる', async () => {
    const first = await passkeyUserId('verifier-one');
    const again = await passkeyUserId('verifier-one');
    const other = await passkeyUserId('verifier-two');
    expect(first).toHaveLength(16);
    expect(again).toEqual(first);
    expect(Buffer.from(other).toString('hex')).not.toBe(Buffer.from(first).toString('hex'));
  });
});

describe('保存レコードの検査とボルトへの紐づけ', () => {
  it('正しい形のレコードだけを受け付ける', () => {
    expect(isValidPasskeyRecord(record())).toBe(true);
    expect(isValidPasskeyRecord(null)).toBe(false);
    expect(isValidPasskeyRecord({ ...record(), v: 2 })).toBe(false);
    expect(isValidPasskeyRecord({ ...record(), id: '' })).toBe(false);
    expect(isValidPasskeyRecord({ ...record(), createdAt: 'yesterday' })).toBe(false);
    expect(isValidPasskeyRecord({ ...record(), prfSalt: '' })).toBe(false);
    expect(isValidPasskeyRecord({ ...record(), prfSalt: bytesToBase64(new Uint8Array(4)) })).toBe(false);
    expect(isValidPasskeyRecord({ ...record(), prfSalt: 'not base64!' })).toBe(false);
    expect(isValidPasskeyRecord({ ...record(), verifier: '' })).toBe(false);
    expect(isValidPasskeyRecord({ ...record(), wrappedDek: { iv: 'aXY=' } })).toBe(false);
    expect(isValidPasskeyRecord({ ...record(), transports: [1] })).toBe(false);
    // transports は省略できる（申告しない認証器もある）。
    const { transports: _omitted, ...withoutTransports } = record();
    expect(isValidPasskeyRecord(withoutTransports)).toBe(true);
  });

  it('封筒の verifier が一致する登録だけを残す', () => {
    const records = [
      record({ id: 'a', verifier: 'verifier-one' }),
      record({ id: 'b', verifier: 'verifier-two' }),
      record({ id: 'c', verifier: 'verifier-one' }),
      { ...record({ id: 'd' }), verifier: '' } as PasskeyRecord,
    ];
    const valid = validPasskeysForEnvelope(records, envelope());
    expect(valid.map((item) => item.id)).toEqual(['a', 'c']);
  });

  it('DEK が同じまま封筒だけ変わったら指紋を付け替える（変化が無ければ同一参照）', () => {
    const records = [record({ id: 'a', vaultFingerprint: 'old' }), record({ id: 'b', vaultFingerprint: 'new' })];
    const rebound = bindPasskeysToFingerprint(records, 'new');
    expect(rebound[0]?.vaultFingerprint).toBe('new');
    expect(rebound[1]).toBe(records[1]);
    expect(isPasskeyBoundTo(rebound[0] as PasskeyRecord, 'new')).toBe(true);
    expect(isPasskeyBoundTo(rebound[0] as PasskeyRecord, 'old')).toBe(false);
  });

  it('パスワード変更で封筒の指紋が変わっても、DEK が同じなら有効なまま', () => {
    const rewrapped = envelope({ kdf: { name: 'PBKDF2-SHA256', iterations: 600_000, salt: 'bmV3' } });
    expect(validPasskeysForEnvelope([record()], rewrapped)).toHaveLength(1);
  });
});
