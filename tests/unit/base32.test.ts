import { describe, expect, it } from 'vitest';
import { Base32Error, canonicalBase32, decodeBase32, encodeBase32, isValidBase32, normalizeBase32 } from '../../shared/base32';

describe('Base32', () => {
  it('既知のベクタをエンコードできる', () => {
    expect(encodeBase32(new TextEncoder().encode(''))).toBe('');
    expect(encodeBase32(new TextEncoder().encode('f'))).toBe('MY');
    expect(encodeBase32(new TextEncoder().encode('fo'))).toBe('MZXQ');
    expect(encodeBase32(new TextEncoder().encode('foo'))).toBe('MZXW6');
    expect(encodeBase32(new TextEncoder().encode('foob'))).toBe('MZXW6YQ');
    expect(encodeBase32(new TextEncoder().encode('fooba'))).toBe('MZXW6YTB');
    expect(encodeBase32(new TextEncoder().encode('foobar'))).toBe('MZXW6YTBOI');
  });

  it('デコードで元に戻る', () => {
    const samples = ['f', 'fo', 'foo', 'foob', 'fooba', 'foobar', 'Hello, Zekey!', '12345678901234567890'];
    for (const sample of samples) {
      const encoded = encodeBase32(new TextEncoder().encode(sample));
      expect(new TextDecoder().decode(decodeBase32(encoded))).toBe(sample);
    }
    // 空文字はエンコードで空になり、デコード側は明示的にエラーにする。
    expect(encodeBase32(new Uint8Array())).toBe('');
    expect(() => decodeBase32('')).toThrow();
  });

  it('ランダムなバイト列でも往復する', () => {
    for (let length = 1; length <= 40; length += 1) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 37 + length * 11) % 256;
      expect([...decodeBase32(encodeBase32(bytes))]).toEqual([...bytes]);
    }
  });

  it('小文字・空白・パディングを許容する', () => {
    expect(normalizeBase32('mzxw 6ytb oi==')).toBe('MZXW6YTBOI');
    expect([...decodeBase32('mzxw6ytboi')]).toEqual([...new TextEncoder().encode('foobar')]);
    expect([...decodeBase32(' MZXW6YTBOI==\n')]).toEqual([...new TextEncoder().encode('foobar')]);
    expect(canonicalBase32(' jbswy3dpehpk3pxp ')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('canonicalBase32 は未使用ビットの違いも同じ文字列に揃える', () => {
    // MY / MZ はどちらも [0x66] に復号される。
    expect([...decodeBase32('MY')]).toEqual([...decodeBase32('MZ')]);
    expect(canonicalBase32('MY')).toBe(canonicalBase32('MZ'));
    expect(canonicalBase32('my')).toBe('MY');
    // 破壊的な変更ではない（正常な secret はそのまま）。
    expect(canonicalBase32('JBSWY3DPEHPK3PXP')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('不正文字で例外を投げる', () => {
    expect(() => decodeBase32('MZXW6!')).toThrow(Base32Error);
    expect(() => decodeBase32('0189')).toThrow(Base32Error);
    expect(() => decodeBase32('')).toThrow(Base32Error);
    expect(() => decodeBase32('A')).toThrow(Base32Error);
  });

  it('isValidBase32 は真偽値で返す', () => {
    expect(isValidBase32('JBSWY3DPEHPK3PXP')).toBe(true);
    expect(isValidBase32('JBSWY3DPEHPK3PX1')).toBe(false);
    expect(isValidBase32('')).toBe(false);
  });

  it('6 桁コード表示向けの典型 secret が往復する', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(encodeBase32(decodeBase32(secret))).toBe(secret);
  });
});
