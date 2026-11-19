/**
 * IP 単位のトークンバケット型レート制限（プロセス内 Map + 定期掃除）。
 * 超過時は 429 と Retry-After を返す。
 *
 * キーは原則として「ソケットの接続元 IP」を使う。転送ヘッダ（X-Forwarded-For /
 * X-Real-IP）は、TRUST_PROXY=true で信頼できるプロキシ配下にあると明示された
 * 場合だけ採用する（未検証ヘッダをそのまま信用すると簡単に回避される）。
 *
 * X-Forwarded-For はクライアントが自由に付けられるため、**左端は信用しない**。
 * 各プロキシが受信元を右端に追加するので、右端から `trustProxyHops` 番目の値
 * （既定 1 = 直近のプロキシが付けたアドレス）を採用する。
 *
 * 転送ヘッダは X-Forwarded-For だけを読む。`X-Real-IP` は「プロキシが上書きする」
 * 保証が無く、無ければソケットの IP（= プロキシ自身）にフォールバックする方が安全。
 * そのため前段プロキシで X-Forwarded-For を設定/上書きする必要がある。
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
  /** 信頼するプロキシの段数（X-Forwarded-For の右端から数える。既定 1） */
  trustProxyHops?: number;
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
  const trustProxyHops = normalizeHops(options.trustProxyHops);
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
    const ip = options.keyFn?.(c) ?? getClientIp(c, trustProxy, trustProxyHops);
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

/** 信頼するホップ数（1〜10 の整数。不正値は 1）。 */
function normalizeHops(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, 10);
}

/**
 * 転送ヘッダからクライアント IP を取り出す（信頼できる場合のみ使う）。
 * X-Forwarded-For は右端から数える（左端はクライアントが偽装できる）。
 */
function forwardedIp(c: ContextLike, hops: number): string | null {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded !== undefined && forwarded.trim() !== '') {
    const parts = forwarded
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    const candidate = parts[Math.max(0, parts.length - hops)];
    if (candidate !== undefined && candidate !== '') return candidate;
  }
  return null;
}

/**
 * レート制限のキーにするクライアント IP。
 * - trustProxy=false（既定）: ソケットの接続元 IP。無ければ転送ヘッダ（テストや
 *   直接のアプリ呼び出しではソケットが無いため）。
 * - trustProxy=true: プロキシが置き換える転送ヘッダを優先し、無ければソケット。
 */
export function getClientIp(c: ContextLike, trustProxy = false, trustProxyHops = 1): string {
  if (trustProxy) {
    return forwardedIp(c, normalizeHops(trustProxyHops)) ?? getSocketIp(c) ?? 'unknown';
  }
  return getSocketIp(c) ?? 'local';
}

/** テスト用: バケットを共有しない新しいリミッタを作るヘルパ。 */
export function createInMemoryRateLimitStore(): Map<string, Bucket> {
  return new Map<string, Bucket>();
}
