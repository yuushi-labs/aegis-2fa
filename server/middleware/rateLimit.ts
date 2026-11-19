/**
 * IP 単位のトークンバケット型レート制限（プロセス内 Map + 定期掃除）。
 * 超過時は 429 と Retry-After を返す。
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
};

type Bucket = {
  count: number;
  resetAt: number;
};

const SWEEP_INTERVAL_MS = 60_000;

export function createRateLimiter(options: RateLimitOptions): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();
  const now = options.now ?? (() => Date.now());
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
    const ip = options.keyFn?.(c) ?? getClientIp(c);
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

export function getClientIp(c: ContextLike): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded !== undefined && forwarded.trim() !== '') {
    const first = forwarded.split(',')[0];
    if (first !== undefined) return first.trim();
  }
  const realIp = c.req.header('x-real-ip');
  if (realIp !== undefined && realIp.trim() !== '') return realIp.trim();
  return 'unknown';
}

/** テスト用: バケットを共有しない新しいリミッタを作るヘルパ。 */
export function createInMemoryRateLimitStore(): Map<string, Bucket> {
  return new Map<string, Bucket>();
}
