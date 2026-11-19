import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { DatabaseHandle } from './client';

/** drizzle/ ディレクトリを、開発時・ビルド後・Docker 内のいずれでも解決する。 */
export function resolveMigrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // バンドル後は dist-server/drizzle に同梱される（scripts/copy-migrations.mjs）。
    resolve(here, 'drizzle'),
    resolve(process.cwd(), 'drizzle'),
    resolve(process.cwd(), 'dist-server/drizzle'),
    resolve(here, '../../drizzle'),
    resolve(here, '../../../drizzle'),
    '/app/drizzle',
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'meta', '_journal.json'))) {
      return candidate;
    }
  }
  throw new Error('マイグレーションフォルダ（drizzle/）が見つかりません');
}

export function runMigrations(handle: DatabaseHandle, folder: string = resolveMigrationsFolder()): void {
  migrate(handle.db, { migrationsFolder: folder });
}
