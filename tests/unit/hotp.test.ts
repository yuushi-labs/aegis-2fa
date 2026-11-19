import { describe, expect, it } from 'vitest';
import { generateHOTP, hotpFromHex, dynamicTruncate, counterToBytes } from '../../shared/hotp';
import { utf8ToBytes } from '../../shared/encoding';

/** RFC 4226 Appendix D のテストベクタ（secret = "12345678901234567890"）。 */
const RFC4226_SECRET = utf8ToBytes('12345678901234567890');

const RFC4226_VECTORS = [
  '755224',
  '287082',
  '359152',
  '969429',
  '338314',
  '254676',
  '287922',
  '162583',
  '399871',
  '520489',
] as const;

describe('HOTP (RFC 4226)', () => {
  it.each(RFC4226_VECTORS.map((code, counter) => [counter, code] as const))(
    'counter %i → %s',
    async (counter, expected) => {
      await expect(generateHOTP(RFC4226_SECRET, counter)).resolves.toBe(expected);
    },
  );

  it('16 進ヘルパでも同じ結果になる', async () => {
    const hex = Buffer.from('12345678901234567890').toString('hex');
    await expect(hotpFromHex(hex, 0)).resolves.toBe('755224');
  });

  it('8 桁指定で先頭 2 桁が付く', async () => {
    await expect(generateHOTP(RFC4226_SECRET, 0, { digits: 8 })).resolves.toBe('84755224');
  });

  it('counterToBytes は 8 バイトのビッグエンディアン', () => {
    expect([...counterToBytes(0)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect([...counterToBytes(1)]).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect([...counterToBytes(0x01020304050607)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect([...counterToBytes(2 ** 32 + 1)]).toEqual([0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('負のカウンタは拒否する', () => {
    expect(() => counterToBytes(-1)).toThrow();
    expect(() => counterToBytes(1.5)).toThrow();
  });

  it('dynamicTruncation は符号ビットを落とす', () => {
    const digest = new Uint8Array(20);
    digest[19] = 0x0f;
    digest[15] = 0xff;
    expect(dynamicTruncate(digest)).toBe(0x7f000000);
  });
});
