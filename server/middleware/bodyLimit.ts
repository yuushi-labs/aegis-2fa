/**
 * body サイズ上限。Content-Length と実バイト数の両方で検査する。
 */

import type { MiddlewareHandler } from 'hono';

/** bodyLimit が後続ハンドラへ渡す生ボディ（Hono の Variables）。 */
export type BodyLimitVariables = {
  rawBody: string;
};

export const DEFAULT_BODY_LIMIT = 256 * 1024;

export function bodyLimit(
  maxBytes: number = DEFAULT_BODY_LIMIT,
): MiddlewareHandler<{ Variables: BodyLimitVariables }> {
  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'DELETE') {
      await next();
      return;
    }
    const contentLength = c.req.header('content-length');
    if (contentLength !== undefined) {
      const declared = Number.parseInt(contentLength, 10);
      if (!Number.isFinite(declared) || declared < 0) {
        return c.json({ error: 'invalid_content_length' }, 400);
      }
      if (declared > maxBytes) {
        return c.json({ error: 'payload_too_large', limit: maxBytes }, 413);
      }
    }
    // Content-Length を信用せず、実際のバイト数でも検査する。
    const raw = await c.req.text();
    if (new TextEncoder().encode(raw).byteLength > maxBytes) {
      return c.json({ error: 'payload_too_large', limit: maxBytes }, 413);
    }
    c.set('rawBody', raw);
    await next();
  };
}
