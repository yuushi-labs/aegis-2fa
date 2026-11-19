/**
 * リクエストログ。メソッド / パス / ステータス / 所要時間のみ。
 * Authorization ヘッダ・body・クエリは絶対に出さない。
 */

import type { MiddlewareHandler } from 'hono';

export type Logger = (line: string) => void;

export function requestLogger(log: Logger = (line) => console.log(line)): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    await next();
    const elapsed = (performance.now() - started).toFixed(1);
    // クエリ文字列は秘匿情報を含みうるので path のみを使う。
    const path = c.req.path;
    log(`${c.req.method} ${path} ${c.res.status} ${elapsed}ms`);
  };
}
