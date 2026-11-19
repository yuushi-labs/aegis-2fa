/**
 * セキュリティヘッダ（全レスポンス）。
 * CSP の connect-src は 'self' 固定 — 外部オリジンへの送信を禁止する。
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
};

export function securityHeaders(options: SecurityOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const headers = c.res.headers;
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
    if (c.req.path.startsWith('/api/')) {
      headers.set('Cache-Control', 'no-store');
    }
  };
}
