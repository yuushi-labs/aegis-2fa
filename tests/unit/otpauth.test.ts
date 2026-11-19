import { describe, expect, it } from 'vitest';
import {
  OtpauthError,
  buildOtpauthUri,
  isMigrationUri,
  isOtpauthUri,
  parseOtpauthUri,
  splitLabel,
  toAccountDraft,
} from '../../shared/otpauth';

describe('otpauth URI', () => {
  it('標準的な TOTP URI をパースする', () => {
    const params = parseOtpauthUri(
      'otpauth://totp/ACME%20Co:john.doe@example.com?secret=JBSWY3DPEHPK3PXP&issuer=ACME%20Co&algorithm=SHA1&digits=6&period=30',
    );
    expect(params).toEqual({
      type: 'totp',
      issuer: 'ACME Co',
      label: 'john.doe@example.com',
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      counter: 0,
    });
  });

  it('issuer はクエリ優先、無ければラベルから', () => {
    expect(parseOtpauthUri('otpauth://totp/Foo:bar?secret=JBSWY3DPEHPK3PXP').issuer).toBe('Foo');
    expect(
      parseOtpauthUri('otpauth://totp/Foo:bar?secret=JBSWY3DPEHPK3PXP&issuer=Baz').issuer,
    ).toBe('Baz');
    expect(parseOtpauthUri('otpauth://totp/bar?secret=JBSWY3DPEHPK3PXP').issuer).toBe('');
  });

  it('HOTP の counter を読む', () => {
    const params = parseOtpauthUri('otpauth://hotp/Test:user?secret=JBSWY3DPEHPK3PXP&counter=42');
    expect(params.type).toBe('hotp');
    expect(params.counter).toBe(42);
    expect(params.period).toBe(30);
  });

  it('欠損パラメータは既定値になる', () => {
    const params = parseOtpauthUri('otpauth://totp/user@example.com?secret=JBSWY3DPEHPK3PXP');
    expect(params.algorithm).toBe('SHA1');
    expect(params.digits).toBe(6);
    expect(params.period).toBe(30);
  });

  it('小文字・空白・パディング入りの secret を正規化する', () => {
    const params = parseOtpauthUri('otpauth://totp/a?secret=jbsw%20y3dp%20ehpk3pxp%3D%3D');
    expect(params.secret).toBe('JBSWY3DPEHPK3PXP');
  });

  it('パース→生成→パースで意味が変わらない', () => {
    const uri =
      'otpauth://totp/ACME%20Co:john.doe@example.com?secret=JBSWY3DPEHPK3PXP&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=60';
    const first = parseOtpauthUri(uri);
    const rebuilt = buildOtpauthUri({ ...first, counter: 0 });
    const second = parseOtpauthUri(rebuilt);
    expect(second).toEqual(first);
  });

  it('HOTP の往復でも counter が保たれる', () => {
    const draft = toAccountDraft(
      parseOtpauthUri('otpauth://hotp/Issuer:acct?secret=JBSWY3DPEHPK3PXP&counter=7&digits=8'),
    );
    const rebuilt = buildOtpauthUri(draft);
    expect(parseOtpauthUri(rebuilt).counter).toBe(7);
    expect(parseOtpauthUri(rebuilt).digits).toBe(8);
  });

  it('issuer が空のときはラベルにコロンを入れない', () => {
    const uri = buildOtpauthUri({
      type: 'totp',
      issuer: '',
      label: 'just-a-label',
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      counter: 0,
    });
    expect(uri.startsWith('otpauth://totp/just-a-label?')).toBe(true);
    expect(parseOtpauthUri(uri).issuer).toBe('');
  });

  it('ラベル内のコロンを含むアカウント名を扱える', () => {
    expect(splitLabel('Issuer:a:b')).toEqual({ issuer: 'Issuer', label: 'a:b' });
  });

  it.each([
    ['otpauth://totp/a?secret=', 'secret が空'],
    ['otpauth://totp/a', 'secret なし'],
    ['https://totp/a?secret=JBSWY3DPEHPK3PXP', 'スキーム違い'],
    ['otpauth://steam/a?secret=JBSWY3DPEHPK3PXP', '種別違い'],
    ['otpauth://totp/a?secret=JBSWY3DPEHPK3PX1', '不正 secret'],
    ['otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&digits=7', '不正桁数'],
    ['otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&algorithm=MD5', '不正アルゴリズム'],
    ['otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&period=0', '不正 period'],
    ['otpauth://hotp/a?secret=JBSWY3DPEHPK3PXP&counter=-1', '不正 counter'],
  ])('不正な URI は例外: %s', (uri) => {
    expect(() => parseOtpauthUri(uri)).toThrow(OtpauthError);
  });

  it('URI 種別判定', () => {
    expect(isOtpauthUri('otpauth://totp/a?secret=JBSWY3DPEHPK3PXP')).toBe(true);
    expect(isOtpauthUri('otpauth-migration://offline?data=x')).toBe(false);
    expect(isMigrationUri('otpauth-migration://offline?data=x')).toBe(true);
  });
});
