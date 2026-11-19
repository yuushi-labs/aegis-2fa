import { describe, expect, it } from 'vitest';
import { generateTOTP, generateTOTPPair, currentStep, secondsRemaining, clampSkew, verifyTOTP } from '../../shared/totp';
import { encodeBase32 } from '../../shared/base32';

/** RFC 6238 のシード（SHA-1 / SHA-256 / SHA-512）。 */
const SEEDS = {
  SHA1: '12345678901234567890',
  SHA256: '12345678901234567890123456789012',
  SHA512: '1234567890123456789012345678901234567890123456789012345678901234',
} as const;

const TIMES = [59, 1111111109, 1111111111, 1234567890, 2000000000] as const;

/** RFC 6238 Appendix B の表（8 桁）。 */
const RFC6238_8DIGITS: Record<keyof typeof SEEDS, readonly string[]> = {
  SHA1: ['94287082', '07081804', '14050471', '89005924', '69279037'],
  SHA256: ['46119246', '68084774', '67062674', '91819424', '90698825'],
  SHA512: ['90693936', '25091201', '99943326', '93441116', '38618901'],
};

/** 同表の 6 桁版（下 6 桁）。 */
function last6(value: string): string {
  return value.slice(-6);
}

describe('TOTP (RFC 6238)', () => {
  for (const algorithm of Object.keys(SEEDS) as (keyof typeof SEEDS)[]) {
    describe(algorithm, () => {
      it.each(TIMES.map((time, index) => [time, RFC6238_8DIGITS[algorithm][index] as string] as const))(
        'T=%i で 8 桁 %s',
        async (time, expected) => {
          const secret = encodeBase32(new TextEncoder().encode(SEEDS[algorithm]));
          await expect(generateTOTP(secret, time, { algorithm, digits: 8 })).resolves.toBe(expected);
        },
      );

      it.each(TIMES.map((time, index) => [time, last6(RFC6238_8DIGITS[algorithm][index] as string)] as const))(
        'T=%i で 6 桁 %s',
        async (time, expected) => {
          const secret = encodeBase32(new TextEncoder().encode(SEEDS[algorithm]));
          await expect(generateTOTP(secret, time, { algorithm, digits: 6 })).resolves.toBe(expected);
        },
      );
    });
  }

  it('period=60 ではステップの切り方が変わる', async () => {
    const secret = encodeBase32(new TextEncoder().encode(SEEDS.SHA1));
    // period 60: T=59 → step 0（RFC 4226 counter 0 の 8 桁）、T=119 → step 1。
    await expect(generateTOTP(secret, 59, { period: 60, digits: 8 })).resolves.toBe('84755224');
    await expect(generateTOTP(secret, 119, { period: 60, digits: 8 })).resolves.toBe('94287082');
  });

  it('currentStep / secondsRemaining', () => {
    expect(currentStep(59, 30)).toBe(1);
    expect(currentStep(60, 30)).toBe(2);
    expect(secondsRemaining(59, 30)).toBe(1);
    expect(secondsRemaining(60, 30)).toBe(30);
    expect(secondsRemaining(61.7, 30)).toBe(29);
  });

  it('period の範囲外は拒否する', () => {
    expect(() => currentStep(0, 0)).toThrow();
    expect(() => currentStep(0, 301)).toThrow();
  });

  it('clampSkew は ±2 に丸める', () => {
    expect(clampSkew(0)).toBe(0);
    expect(clampSkew(5)).toBe(2);
    expect(clampSkew(-5)).toBe(-2);
    expect(clampSkew(1.5)).toBe(0);
  });

  it('次期コードは 1 ステップ先の値になる', async () => {
    const secret = encodeBase32(new TextEncoder().encode(SEEDS.SHA1));
    // T=59 は step 1（RFC の T=59 行）。次は step 2。
    const pair = await generateTOTPPair(secret, 59, { digits: 8 });
    expect(pair.current).toBe('94287082');
    expect(pair.next).toBe(await generateTOTP(secret, 89, { digits: 8 }));
    expect(pair.remaining).toBe(1);
  });

  it('クロックスキューを加算したコードを返す', async () => {
    const secret = encodeBase32(new TextEncoder().encode(SEEDS.SHA1));
    const pair = await generateTOTPPair(secret, 59, { digits: 8, skew: 1 });
    expect(pair.current).toBe(await generateTOTP(secret, 89, { digits: 8 }));
    expect(pair.current).not.toBe('94287082');
  });

  it('verifyTOTP は前後 1 ステップを許容する', async () => {
    const secret = encodeBase32(new TextEncoder().encode(SEEDS.SHA1));
    const pair = await generateTOTPPair(secret, 59, { digits: 8 });
    await expect(verifyTOTP(secret, pair.current, 59, { digits: 8 })).resolves.toBe(true);
    await expect(verifyTOTP(secret, pair.next, 59, { digits: 8 })).resolves.toBe(true);
    await expect(verifyTOTP(secret, pair.next, 59, { digits: 8, window: 0 })).resolves.toBe(false);
    await expect(verifyTOTP(secret, '00000000', 59, { digits: 8 })).resolves.toBe(false);
  });
});
