import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type ZekeyDatabase = BetterSQLite3Database<typeof schema>;

export type DatabaseHandle = {
  db: ZekeyDatabase;
  sqlite: Database.Database;
  path: string;
  close: () => void;
};

export function resolveDatabasePath(rawPath: string | undefined): string {
  const value = rawPath === undefined || rawPath.trim() === '' ? './data/zekey.db' : rawPath;
  if (value === ':memory:') return value;
  return resolve(value);
}

/**
 * DATABASE_PATH のディレクトリ作成込みで DB を開く。
 * マイグレーションはここでは適用しない（migrate.ts の責務）。
 */
export function createDatabase(rawPath: string | undefined): DatabaseHandle {
  const path = resolveDatabasePath(rawPath);
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  return {
    db,
    sqlite,
    path,
    close: () => {
      try {
        sqlite.close();
      } catch {
        // すでに閉じている場合は無視する。
      }
    },
  };
}
