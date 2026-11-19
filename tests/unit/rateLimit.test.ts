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

  it('TRUST_PROXY のときは転送ヘッダの先頭を使う', () => {
    const c = context({ forwardedFor: '198.51.100.1, 10.0.0.1', remoteAddress: '127.0.0.1' });
    expect(getClientIp(c, true)).toBe('198.51.100.1');
    expect(getClientIp(context({ realIp: '198.51.100.2', remoteAddress: '127.0.0.1' }), true)).toBe(
      '198.51.100.2',
    );
  });

  it('TRUST_PROXY でも転送ヘッダが無ければソケットにフォールバックする', () => {
    expect(getClientIp(context({ remoteAddress: '127.0.0.1' }), true)).toBe('127.0.0.1');
  });

  it('ソケットが無い（直接呼び出し・テスト）場合は固定のキーにまとめる', () => {
    expect(getClientIp(context({ forwardedFor: '198.51.100.1' }), false)).toBe('local');
    expect(getClientIp(context({}), true)).toBe('unknown');
  });
});
