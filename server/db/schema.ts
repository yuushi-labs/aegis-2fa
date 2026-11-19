import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * サーバーが保持してよいのは「暗号文・ID・バージョン・時刻」だけ。
 * tokenHash は SHA-256 hex（トークンそのものは保存しない）。
 */
export const vaults = sqliteTable(
  'vaults',
  {
    /** hex(SHA-256(token))[0:32] */
    id: text('id').primaryKey(),
    /** SHA-256 hex 全長 */
    tokenHash: text('token_hash').notNull(),
    /** 封筒 JSON（暗号文のみ） */
    envelope: text('envelope').notNull(),
    revision: integer('revision').notNull().default(0),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => [index('vaults_updated_at_idx').on(table.updatedAt)],
);

export type VaultRow = typeof vaults.$inferSelect;
export type VaultInsert = typeof vaults.$inferInsert;
