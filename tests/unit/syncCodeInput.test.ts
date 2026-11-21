/**
 * 同期コードの受け取り（QR・URL・手入力）の単体テスト。
 */

import { describe, expect, it } from 'vitest';
import { extractSyncCode, extractSyncCodeFromUrl } from '../../src/lib/syncCodeInput';
import { generateSyncToken } from '../../shared/sync';

const TOKEN = generateSyncToken();
const OTHER = generateSyncToken();

function grouped(token: string): string {
  return token.replace(/(.{4})/g, '$1 ').trim();
}

describe('extractSyncCode', () => {
  it('同期コードそのものを受け取る', () => {
    expect(extractSyncCode(TOKEN)).toBe(TOKEN);
    expect(extractSyncCode(`  ${TOKEN}\n`)).toBe(TOKEN);
  });

  it('4 文字区切りの空白入りでも受け取る', () => {
    expect(extractSyncCode(grouped(TOKEN))).toBe(TOKEN);
  });

  it('同期 URL の ?code= から取り出す', () => {
    expect(extractSyncCode(`https://example.com/aegis/sync?code=${TOKEN}`)).toBe(TOKEN);
  });

  it('?sync= と #sync= のどちらでも取り出す', () => {
    expect(extractSyncCode(`https://example.com/sync?sync=${TOKEN}`)).toBe(TOKEN);
    expect(extractSyncCode(`https://example.com/sync#sync=${TOKEN}`)).toBe(TOKEN);
    expect(extractSyncCode(`https://example.com/sync#code=${TOKEN}`)).toBe(TOKEN);
  });

  it('フラグメントに同期コードだけが入っていても取り出す', () => {
    expect(extractSyncCode(`https://example.com/sync#${TOKEN}`)).toBe(TOKEN);
  });

  it('アプリのディープリンクから取り出す', () => {
    expect(extractSyncCode(`aegis://sync?code=${TOKEN}`)).toBe(TOKEN);
  });

  it('パス形式（/sync/<token>）から取り出す', () => {
    expect(extractSyncCode(`/sync/${TOKEN}`)).toBe(TOKEN);
    expect(extractSyncCode(`https://example.com/sync/${TOKEN}`)).toBe(TOKEN);
  });

  it('複数の候補があるときは code → sync の順で先に見つかったものを使う', () => {
    expect(extractSyncCode(`https://example.com/sync?code=${TOKEN}&sync=${OTHER}`)).toBe(TOKEN);
  });

  it('同期コードとして妥当でないものは null', () => {
    expect(extractSyncCode('')).toBeNull();
    expect(extractSyncCode('hello')).toBeNull();
    expect(extractSyncCode('otpauth://totp/Example:me?secret=JBSWY3DPEHPK3PXP')).toBeNull();
    expect(extractSyncCode('https://example.com/sync?code=short')).toBeNull();
    expect(extractSyncCode(`https://example.com/sync?code=${TOKEN.slice(0, 20)}`)).toBeNull();
  });

  it('URL の他のクエリが先にあっても同期コードを見つける', () => {
    expect(extractSyncCode(`https://example.com/x?v=3&code=${TOKEN}&lang=ja`)).toBe(TOKEN);
  });

  it('壊れたパーセントエンコードでも例外にしない', () => {
    expect(extractSyncCode('https://example.com/sync#%E0%A4%A')).toBeNull();
    expect(() => extractSyncCode('/sync/%')).not.toThrow();
  });
});

describe('extractSyncCodeFromUrl', () => {
  it('URL でない文字列は null', () => {
    expect(extractSyncCodeFromUrl(TOKEN)).toBeNull();
    expect(extractSyncCodeFromUrl('plain text')).toBeNull();
  });

  it('同期コードを含まない URL は null', () => {
    expect(extractSyncCodeFromUrl('https://example.com/')).toBeNull();
    expect(extractSyncCodeFromUrl('https://example.com/?code=')).toBeNull();
  });
});
