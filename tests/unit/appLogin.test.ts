import { describe, expect, it } from 'vitest';
import { base64UrlToBytes, bytesToBase64Url, bytesToUtf8, utf8ToBytes } from '../../shared/encoding';
import { APP_LOGIN_URL_PREFIX, buildAppLoginUrl } from '../../src/lib/appLogin';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const DEK = Uint8Array.from([...Array(32).keys()]);

/** フラグメント（`#` 以降）を素朴に読む（アプリ側の実装と同じ手順）。 */
function fragmentParams(url: string): URLSearchParams {
  const hash = url.slice(url.indexOf('#') + 1);
  const params = new URLSearchParams(hash);
  return params;
}

describe('アプリでログイン: ディープリンク', () => {
  it('zekey://login# から始まり、code / dek / name をフラグメントに置く', () => {
    const url = buildAppLoginUrl({ token: TOKEN, dek: DEK, vaultName: 'メイン' });
    expect(url.startsWith(APP_LOGIN_URL_PREFIX)).toBe(true);
    const [head, hash] = url.split('#');
    expect(head).toBe('zekey://login');
    expect(hash).not.toContain('?');
    const params = fragmentParams(url);
    expect([...params.keys()]).toEqual(['code', 'dek', 'name']);
    expect(params.get('name')).toBe('メイン');
  });

  it('code は同期トークンの UTF-8 を base64url 化したもの（アプリ側で復元できる）', () => {
    const params = fragmentParams(buildAppLoginUrl({ token: TOKEN, dek: DEK, vaultName: 'メイン' }));
    const code = params.get('code') ?? '';
    expect(code).toBe(bytesToBase64Url(utf8ToBytes(TOKEN)));
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(bytesToUtf8(base64UrlToBytes(code))).toBe(TOKEN);
  });

  it('dek は DEK の 32 バイトを base64url 化したもの（アプリ側で復元できる）', () => {
    const params = fragmentParams(buildAppLoginUrl({ token: TOKEN, dek: DEK, vaultName: 'メイン' }));
    const dek = params.get('dek') ?? '';
    expect(dek).toBe(bytesToBase64Url(DEK));
    expect([...base64UrlToBytes(dek)]).toEqual([...DEK]);
  });

  it('ボルト名は URL エンコードされる（記号・空白・日本語）', () => {
    const url = buildAppLoginUrl({ token: TOKEN, dek: DEK, vaultName: '仕事 & 私用 #2' });
    expect(url).not.toContain('仕事');
    expect(fragmentParams(url).get('name')).toBe('仕事 & 私用 #2');
    expect(url.endsWith('name=%E4%BB%95%E4%BA%8B%20%26%20%E7%A7%81%E7%94%A8%20%232')).toBe(true);
  });

  it('URL 全体がスキーム・フラグメント以外の予約文字を含まない（コピーしても壊れない）', () => {
    const url = buildAppLoginUrl({ token: TOKEN, dek: DEK, vaultName: 'My vault' });
    const hash = url.slice(url.indexOf('#') + 1);
    expect(hash).not.toMatch(/[\s#?]/);
    expect(new URL(url).protocol).toBe('zekey:');
    expect(new URL(url).hash).toContain('code=');
  });

  it('同じ入力からは同じ URL を作る', () => {
    const first = buildAppLoginUrl({ token: TOKEN, dek: DEK, vaultName: 'メイン' });
    const second = buildAppLoginUrl({ token: TOKEN, dek: DEK, vaultName: 'メイン' });
    expect(first).toBe(second);
  });
});
