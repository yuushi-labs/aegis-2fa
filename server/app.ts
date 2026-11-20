/**
 * Hono アプリ。テストからは app.request(...) で inject できる。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit, type BodyLimitVariables } from './middleware/bodyLimit';
import { createRateLimiter } from './middleware/rateLimit';
import { requestLogger } from './middleware/logger';
import { applySecurityHeaders, securityHeaders } from './middleware/security';
import { createHealthRoutes } from './routes/health';
import { createVaultRoutes } from './routes/vault';
import type { DatabaseHandle } from './db/client';

export type AppOptions = {
  database: DatabaseHandle;
  version?: string;
  /** TRUST_PROXY=true のとき X-Forwarded-* を信頼する（レート制限のキー） */
  trustProxy?: boolean;
  /** 信頼するプロキシの段数（X-Forwarded-For の右端から数える。既定 1） */
  trustProxyHops?: number;
  /** 保存できる暗号文の総量（バイト）。超過した書き込みは 507。既定 256 MiB */
  maxVaultBytes?: number;
  /** HTTPS 終端されている場合に HSTS を付ける */
  https?: boolean;
  /** 同一オリジン以外を許可する場合のみ設定 */
  corsOrigin?: string;
  /** 静的ファイルのルート（dist/）。未指定なら静的配信しない */
  staticRoot?: string;
  /** ログ出力（テストで握りつぶすため） */
  log?: (line: string) => void;
  /** レート制限の無効化（テスト用） */
  disableRateLimit?: boolean;
  /** レート制限の時計（テスト用） */
  now?: () => number;
};

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

const ASSET_CACHE = 'public, max-age=31536000, immutable';
const FILE_CACHE = 'public, max-age=3600';
const HTML_CACHE = 'no-store';

function mimeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function readStaticFile(root: string, relativePath: string): { body: Buffer; type: string; cache: string } | null {
  if (relativePath === '' || relativePath.includes('..') || relativePath.includes('\0')) return null;
  const candidate = resolve(root, relativePath);
  if (!candidate.startsWith(root + sep)) return null;
  if (!existsSync(candidate)) return null;
  if (!statSync(candidate).isFile()) return null;
  return {
    body: readFileSync(candidate),
    type: mimeFor(candidate),
    cache: cacheControlFor(relativePath),
  };
}

/** HTML は no-store（デプロイ直後に古い index を参照しない）、assets/ は immutable。 */
function cacheControlFor(relativePath: string): string {
  if (relativePath.startsWith('assets/')) return ASSET_CACHE;
  if (/\.html?$/i.test(relativePath)) return HTML_CACHE;
  return FILE_CACHE;
}

export function createApp(options: AppOptions): Hono<{ Variables: BodyLimitVariables }> {
  const app = new Hono<{ Variables: BodyLimitVariables }>();
  const log = options.log ?? ((line: string) => console.log(line));
  const version = options.version ?? '1.0.0';

  app.use('*', securityHeaders({ https: options.https === true }));
  app.use('*', requestLogger(log));

  if (options.corsOrigin !== undefined && options.corsOrigin !== '') {
    app.use(
      '/api/*',
      cors({
        origin: options.corsOrigin,
        allowMethods: ['GET', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: 600,
      }),
    );
  }

  // レート制限: /api/vault/* 60/min、PUT は 20/min。
  // キーはソケットの接続元 IP。転送ヘッダは TRUST_PROXY=true のときだけ信用する。
  if (options.disableRateLimit !== true) {
    const clock = options.now === undefined ? {} : { now: options.now };
    const trustProxy = options.trustProxy === true;
    const trustProxyHops = options.trustProxyHops ?? 1;
    const vaultLimiter = createRateLimiter({
      name: 'vault',
      windowMs: 60_000,
      max: 60,
      trustProxy,
      trustProxyHops,
      ...clock,
    });
    const putLimiter = createRateLimiter({
      name: 'vault-put',
      windowMs: 60_000,
      max: 20,
      trustProxy,
      trustProxyHops,
      ...clock,
    });
    app.use('/api/vault/*', vaultLimiter);
    app.use('/api/vault/:id', async (c, next) => {
      if (c.req.method !== 'PUT') {
        await next();
        return;
      }
      return putLimiter(c, next);
    });
  }

  app.route('/api/health', createHealthRoutes({ db: options.database.db, version }));

  app.use('/api/vault/*', bodyLimit(256 * 1024));
  app.route(
    '/api/vault',
    createVaultRoutes({
      db: options.database.db,
      ...(options.maxVaultBytes === undefined ? {} : { maxVaultBytes: options.maxVaultBytes }),
    }),
  );

  app.notFound((c) => {
    const path = c.req.path;
    if (path.startsWith('/api/')) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (options.staticRoot === undefined) {
      return c.html('<!doctype html><title>Aegis 2FA</title><p>クライアントは未ビルドです。</p>', 404);
    }
    const root = resolve(options.staticRoot);
    const found = readStaticFile(root, path.replace(/^\/+/, ''));
    if (found !== null) {
      return new Response(new Uint8Array(found.body), {
        status: 200,
        headers: { 'Content-Type': found.type, 'Cache-Control': found.cache },
      });
    }
    const indexPath = join(root, 'index.html');
    if (!existsSync(indexPath)) {
      return c.html('<!doctype html><title>Aegis 2FA</title><p>index.html が見つかりません。</p>', 404);
    }
    return new Response(new Uint8Array(readFileSync(indexPath)), {
      status: 200,
      headers: { 'Content-Type': MIME_TYPES['.html'] as string, 'Cache-Control': HTML_CACHE },
    });
  });

  app.onError((error, c) => {
    log(`ERROR ${c.req.method} ${c.req.path} ${error.name}`);
    const message = process.env.NODE_ENV === 'production' ? 'internal_error' : error.message;
    const response = c.json({ error: 'internal_error', message }, 500);
    // 例外時は securityHeaders ミドルウェアの後処理が走らないため、ここでも付与する。
    applySecurityHeaders(response.headers, { https: options.https === true, path: c.req.path });
    return response;
  });

  return app;
}
