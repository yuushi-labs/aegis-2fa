import { describe, expect, it } from 'vitest';
import { getClientIp, getSocketIp } from '../../server/middleware/rateLimit';

type FakeContext = Parameters<typeof getClientIp>[0];

function context(options: {
  forwardedFor?: string;
  realIp?: string;
  remoteAddress?: string;
}): FakeContext {
  const headers: Record<string, string> = {};
  if (options.forwardedFor !== undefined) headers['x-forwarded-for'] = options.forwardedFor;
  if (options.realIp !== undefined) headers['x-real-ip'] = options.realIp;
  const env =
    options.remoteAddress === undefined
      ? undefined
      : { incoming: { socket: { remoteAddress: options.remoteAddress } } };
  return {
    env,
    req: {
      header: (name: string) => headers[name.toLowerCase()],
    },
  } as unknown as FakeContext;
}

describe('レート制限のクライアント IP', () => {
  it('ソケットの接続元 IP を読む', () => {
    expect(getSocketIp(context({ remoteAddress: '203.0.113.5' }))).toBe('203.0.113.5');
    expect(getSocketIp(context({}))).toBeNull();
  });

  it('TRUST_PROXY でないときは転送ヘッダを無視する', () => {
    const c = context({ forwardedFor: '198.51.100.1', realIp: '198.51.100.2', remoteAddress: '203.0.113.9' });
    expect(getClientIp(c, false)).toBe('203.0.113.9');
  });

  it('TRUST_PROXY のときは右端（直近のプロキシが付けた値）を使う', () => {
    const c = context({ forwardedFor: '198.51.100.1, 10.0.0.1', remoteAddress: '127.0.0.1' });
    // 左端はクライアントが自由に付けられるため採用しない。
    expect(getClientIp(c, true)).toBe('10.0.0.1');
  });

  it('X-Real-IP だけではキーにしない（偽装で回避できないようソケットへ戻す）', () => {
    const c = context({ realIp: '198.51.100.2', remoteAddress: '127.0.0.1' });
    expect(getClientIp(c, true)).toBe('127.0.0.1');
  });

  it('偽装された XFF を足しても、プロキシが付けた右端は変わらない', () => {
    const spoofed = context({
      forwardedFor: '203.0.113.77, 198.51.100.9',
      remoteAddress: '127.0.0.1',
    });
    const plain = context({ forwardedFor: '198.51.100.9', remoteAddress: '127.0.0.1' });
    expect(getClientIp(spoofed, true)).toBe(getClientIp(plain, true));
  });

  it('TRUST_PROXY_HOPS で多段プロキシの段数を指定できる', () => {
    const c = context({ forwardedFor: '198.51.100.1, 10.0.0.1, 10.0.0.2', remoteAddress: '127.0.0.1' });
    expect(getClientIp(c, true, 1)).toBe('10.0.0.2');
    expect(getClientIp(c, true, 2)).toBe('10.0.0.1');
    expect(getClientIp(c, true, 3)).toBe('198.51.100.1');
    // 範囲外・不正値は 1 に丸める（ホップ数を減らしても左端へは飛ばない）。
    expect(getClientIp(c, true, 0)).toBe('10.0.0.2');
    expect(getClientIp(c, true, 99)).toBe('198.51.100.1');
    expect(getClientIp(c, true, Number.NaN)).toBe('10.0.0.2');
  });

  it('TRUST_PROXY でも転送ヘッダが無ければソケットにフォールバックする', () => {
    expect(getClientIp(context({ remoteAddress: '127.0.0.1' }), true)).toBe('127.0.0.1');
  });

  it('ソケットが無い（直接呼び出し・テスト）場合は固定のキーにまとめる', () => {
    expect(getClientIp(context({ forwardedFor: '198.51.100.1' }), false)).toBe('local');
    expect(getClientIp(context({}), true)).toBe('unknown');
  });
});
