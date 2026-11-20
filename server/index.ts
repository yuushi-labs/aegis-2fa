/**
 * エントリ。設定は process.env からのみ読む。
 * PORT / DATABASE_PATH / TRUST_PROXY / CORS_ORIGIN / AEGIS_HTTPS
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { createDatabase } from './db/client';
import { runMigrations } from './db/migrate';

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '1.0.0';
  } catch {
    return '1.0.0';
  }
}

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const databasePath = process.env.DATABASE_PATH ?? './data/aegis.db';
const trustProxy = process.env.TRUST_PROXY === 'true';
const trustProxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? '1', 10);
const maxVaultBytes = Number.parseInt(process.env.MAX_VAULT_BYTES ?? String(256 * 1024 * 1024), 10);
const corsOrigin = process.env.CORS_ORIGIN;
const https = process.env.AEGIS_HTTPS === 'true';

const database = createDatabase(databasePath);
runMigrations(database);

const distDir = resolve(process.cwd(), 'dist');
const staticRoot = existsSync(distDir) ? distDir : undefined;

const app = createApp({
  database,
  version: readVersion(),
  trustProxy,
  trustProxyHops: Number.isFinite(trustProxyHops) ? trustProxyHops : 1,
  maxVaultBytes: Number.isFinite(maxVaultBytes) && maxVaultBytes > 0 ? maxVaultBytes : 256 * 1024 * 1024,
  https,
  ...(corsOrigin === undefined ? {} : { corsOrigin }),
  ...(staticRoot === undefined ? {} : { staticRoot }),
  log: (line) => console.log(line),
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Aegis 2FA listening on http://localhost:${info.port}`);
  console.log(`DATABASE_PATH=${database.path}`);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    database.close();
    process.exit(0);
  });
  // 10 秒で強制終了（ハング防止）。
  setTimeout(() => {
    database.close();
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
