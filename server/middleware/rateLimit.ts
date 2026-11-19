/**
 * IP 単位のトークンバケット型レート制限（プロセス内 Map + 定期掃除）。
 * 超過時は 429 と Retry-After を返す。
 *
 * キーは原則として「ソケットの接続元 IP」を使う。転送ヘッダ（X-Forwarded-For /
 * X-Real-IP）は、TRUST_PROXY=true で信頼できるプロキシ配下にあると明示された
 * 場合だけ採用する（未検証ヘッダをそのまま信用すると簡単に回避される）。
 */

import type { MiddlewareHandler } from 'hono';

export type RateLimitOptions = {
  /** ウィンドウ長（ミリ秒） */
  windowMs: number;
  /** ウィンドウ内の最大リクエスト数 */
  max: number;
  /** バケットのキー接頭辞（GET/PUT を別勘定にする） */
  name: string;
  /** キー抽出（既定は IP） */
  keyFn?: (c: Parameters<MiddlewareHandler>[0]) => string;
  /** テスト用の時計 */
  now?: () => number;
  /** TRUST_PROXY=true のときだけ転送ヘッダを信頼する */
  trustProxy?: boolean;
};

type Bucket = {
  count: number;
  resetAt: number;
};

const SWEEP_INTERVAL_MS = 60_000;

export function createRateLimiter(options: RateLimitOptions): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();
  const now = options.now ?? (() => Date.now());
  const trustProxy = options.trustProxy === true;
  let lastSweep = now();

  function sweep(current: number): void {
    if (current - lastSweep < SWEEP_INTERVAL_MS) return;
    lastSweep = current;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= current) buckets.delete(key);
    }
  }

  return async (c, next) => {
    const current = now();
    sweep(current);
    const ip = options.keyFn?.(c) ?? getClientIp(c, trustProxy);
    const key = `${options.name}:${ip}`;
    let bucket = buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= current) {
      bucket = { count: 0, resetAt: current + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > options.max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - current) / 1000));
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: 'rate_limited', retryAfter }, 429);
    }
    c.header('X-RateLimit-Limit', String(options.max));
    c.header('X-RateLimit-Remaining', String(Math.max(0, options.max - bucket.count)));
    await next();
  };
}

type ContextLike = Parameters<MiddlewareHandler>[0];

/** @hono/node-server が渡す Node の IncomingMessage（型は緩く扱う）。 */
type NodeBindings = {
  incoming?: { socket?: { remoteAddress?: string } };
};

/** ソケットの接続元 IP（プロキシを経由しない素の相手）。 */
export function getSocketIp(c: ContextLike): string | null {
  const env = (c as unknown as { env?: NodeBindings }).env;
  const address = env?.incoming?.socket?.remoteAddress;
  if (typeof address === 'string' && address !== '') return address;
  return null;
}

/** 転送ヘッダの先頭要素（信頼できる場合のみ使う）。 */
function forwardedIp(c: ContextLike): string | null {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded !== undefined && forwarded.trim() !== '') {
    const first = forwarded.split(',')[0];
    if (first !== undefined && first.trim() !== '') return first.trim();
  }
  const realIp = c.req.header('x-real-ip');
  if (realIp !== undefined && realIp.trim() !== '') return realIp.trim();
  return null;
}

/**
 * レート制限のキーにするクライアント IP。
 * - trustProxy=false（既定）: ソケットの接続元 IP。無ければ転送ヘッダ（テストや
 *   直接のアプリ呼び出しではソケットが無いため）。
 * - trustProxy=true: プロキシが置き換える転送ヘッダを優先し、無ければソケット。
 */
export function getClientIp(c: ContextLike, trustProxy = false): string {
  if (trustProxy) {
    return forwardedIp(c) ?? getSocketIp(c) ?? 'unknown';
  }
  return getSocketIp(c) ?? 'local';
}

/** テスト用: バケットを共有しない新しいリミッタを作るヘルパ。 */
export function createInMemoryRateLimitStore(): Map<string, Bucket> {
  return new Map<string, Bucket>();
}
