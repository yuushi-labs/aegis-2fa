/**
 * body サイズ上限。Content-Length と実バイト数の両方で検査する。
 *
 * Content-Length が無い（chunked）場合でも、読み込みながら累積バイト数を見て
 * 上限を超えた時点で中断し 413 を返す（解析後のサイズ確認では過大なバッファリングを防げない）。
 */

import type { MiddlewareHandler } from 'hono';

/** bodyLimit が後続ハンドラへ渡す生ボディ（Hono の Variables）。 */
export type BodyLimitVariables = {
  rawBody: string;
};

export const DEFAULT_BODY_LIMIT = 256 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super('payload_too_large');
    this.name = 'BodyTooLargeError';
  }
}

/** ストリームを上限付きで読む。上限超過は BodyTooLargeError。 */
async function readLimited(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let total = 0;
  let out = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new BodyTooLargeError();
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  } finally {
    // 中断した場合もストリームを閉じる（読み残しを保持しない）。
    try {
      await reader.cancel();
    } catch {
      // すでに閉じている場合は無視する。
    }
  }
}

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

    const body = c.req.raw.body;
    let raw: string;
    if (body === null) {
      raw = '';
    } else {
      try {
        raw = await readLimited(body, maxBytes);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          return c.json({ error: 'payload_too_large', limit: maxBytes }, 413);
        }
        throw error;
      }
    }
    c.set('rawBody', raw);
    await next();
  };
}
