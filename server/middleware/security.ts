/**
 * セキュリティヘッダ（全レスポンス）。
 * CSP の connect-src は 'self' 固定 — 外部オリジンへの送信を禁止する。
 *
 * ミドルウェアは `await next()` の後にヘッダを付けるが、下流が例外を投げた場合は
 * その後の処理が走らない。`onError` が作る 500 応答にも同じヘッダを付けるため、
 * 付与処理を `applySecurityHeaders` に切り出して両方から呼ぶ。
 */

import type { MiddlewareHandler } from 'hono';

export const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export type SecurityOptions = {
  /** HTTPS のときだけ HSTS を付ける */
  https?: boolean;
  /** リクエストパス（`/api/*` に no-store を付けるため） */
  path?: string;
};

/** 応答ヘッダへセキュリティヘッダを付与する（既に付いていれば何もしない）。 */
export function applySecurityHeaders(headers: Headers, options: SecurityOptions = {}): void {
  if (headers.has('content-security-policy')) return;

  headers.set('Content-Security-Policy', CSP_DIRECTIVES);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), interest-cohort=()');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  if (options.https === true) {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (options.path !== undefined && options.path.startsWith('/api/')) {
    headers.set('Cache-Control', 'no-store');
  }
}

export function securityHeaders(options: SecurityOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    await next();
    applySecurityHeaders(c.res.headers, { https: options.https, path: c.req.path });
  };
}
