import { describe, expect, it } from 'vitest';
import { detectSecretUri, draftFromOtpauthUri } from '../../src/lib/secretUri';
import { EMPTY_DRAFT } from '../../src/lib/accountDraft';

describe('シークレット欄の URI 検出', () => {
  it('otpauth URI を検出して前後の空白を落とす', () => {
    expect(detectSecretUri('  otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP\n')).toEqual({
      kind: 'otpauth',
      uri: 'otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP',
    });
  });

  it('スキームの大小文字を問わない', () => {
    expect(detectSecretUri('OTPAUTH://totp/a?secret=JBSWY3DPEHPK3PXP')?.kind).toBe('otpauth');
    expect(detectSecretUri('Otpauth-Migration://offline?data=abc')?.kind).toBe('migration');
  });

  it('コピー経由で混ざるゼロ幅文字を落とす', () => {
    expect(detectSecretUri('\u200botpauth://totp/a?secret=JBSWY3DPEHPK3PXP\ufeff')?.uri).toBe(
      'otpauth://totp/a?secret=JBSWY3DPEHPK3PXP',
    );
  });

  it('移行 URI は otpauth と区別する', () => {
    expect(detectSecretUri('otpauth-migration://offline?data=abc')).toEqual({
      kind: 'migration',
      uri: 'otpauth-migration://offline?data=abc',
    });
  });

  it('秘密鍵（Base32）や他の URL は URI として扱わない', () => {
    expect(detectSecretUri('JBSWY3DPEHPK3PXP')).toBeNull();
    expect(detectSecretUri(' jbswy3dp ehpk3pxp ')).toBeNull();
    expect(detectSecretUri('')).toBeNull();
    expect(detectSecretUri('https://example.com/otpauth://totp/a?secret=JBSWY3DPEHPK3PXP')).toBeNull();
    expect(detectSecretUri('otpauth:/totp/a?secret=JBSWY3DPEHPK3PXP')).toBeNull();
  });
});

describe('otpauth URI からフォーム下書きへの展開', () => {
  it('サービス名・アカウント名・秘密鍵・詳細設定をまとめて入れる', () => {
    const draft = draftFromOtpauthUri(
      'otpauth://totp/GitHub:octocat%40example.com?secret=jbswy3dp%20ehpk3pxp&issuer=GitHub&algorithm=SHA256&digits=8&period=60',
    );
    expect(draft).toEqual({
      ...EMPTY_DRAFT,
      issuer: 'GitHub',
      label: 'octocat@example.com',
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA256',
      digits: 8,
      period: 60,
    });
  });

  it('クエリの issuer を優先し、無ければラベルから分ける', () => {
    expect(draftFromOtpauthUri('otpauth://totp/Foo:bar?secret=JBSWY3DPEHPK3PXP').issuer).toBe('Foo');
    expect(
      draftFromOtpauthUri('otpauth://totp/Foo:bar?secret=JBSWY3DPEHPK3PXP&issuer=Baz').issuer,
    ).toBe('Baz');
    expect(draftFromOtpauthUri('otpauth://totp/bar?secret=JBSWY3DPEHPK3PXP').issuer).toBe('');
  });

  it('HOTP の counter と、欠損パラメータの既定値を反映する', () => {
    const hotp = draftFromOtpauthUri('otpauth://hotp/Steam:me?secret=JBSWY3DPEHPK3PXP&counter=7');
    expect(hotp).toMatchObject({ type: 'hotp', counter: 7, algorithm: 'SHA1', digits: 6, period: 30 });

    const totp = draftFromOtpauthUri('otpauth://totp/Notion:me?secret=JBSWY3DPEHPK3PXP');
    expect(totp).toMatchObject({ type: 'totp', counter: 0, algorithm: 'SHA1', digits: 6, period: 30 });
  });

  it('壊れた URI は例外にする（フォームを書き換えない）', () => {
    expect(() => draftFromOtpauthUri('otpauth://totp/a?issuer=x')).toThrow();
    expect(() => draftFromOtpauthUri('otpauth://steam/a?secret=JBSWY3DPEHPK3PXP')).toThrow();
    expect(() => draftFromOtpauthUri('not a uri')).toThrow();
  });
});
