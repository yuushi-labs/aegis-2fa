/**
 * /api/vault/* — 暗号文の保存のみ。認可は Bearer トークンの SHA-256 一致。
 *
 * レスポンスに平文の秘密鍵・パスワードは決して含めない（そもそも受け取らない）。
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { timingSafeEqualString } from '../../shared/encoding';
import { MAX_KDF_ITERATIONS, MIN_KDF_ITERATIONS } from '../../shared/types';
import { deriveTokenHash, deriveVaultId, isValidVaultId } from '../../shared/sync';
import { vaults } from '../db/schema';
import type { ZekeyDatabase } from '../db/client';
import type { BodyLimitVariables } from '../middleware/bodyLimit';

const cipherSchema = z.object({
  iv: z.string().min(1).max(64),
  ciphertext: z.string().min(1).max(200_000),
});

export const envelopeSchema = z
  .object({
    format: z.literal('aegis-vault'),
    version: z.literal(1),
    kdf: z.object({
      name: z.literal('PBKDF2-SHA256'),
      // 上限はクライアント側（shared/types.ts の MAX_KDF_ITERATIONS）と揃える。
      iterations: z.number().int().min(MIN_KDF_ITERATIONS).max(MAX_KDF_ITERATIONS),
      salt: z.string().min(1).max(64),
    }),
    wrappedKey: cipherSchema,
    data: cipherSchema,
    verifier: z.string().min(1).max(64),
    revision: z.number().int().min(0),
    updatedAt: z.string().min(1).max(64),
  })
  .strict();

export const putBodySchema = z
  .object({
    envelope: envelopeSchema,
    revision: z.number().int().min(0),
  })
  .strict();

/** 保存できる暗号文の総量の既定値（256 MiB）。 */
export const DEFAULT_MAX_VAULT_BYTES = 256 * 1024 * 1024;

export type VaultRoutesOptions = {
  db: ZekeyDatabase;
  /** 保存できる暗号文の総量（バイト）。超過する書き込みは 507 を返す。 */
  maxVaultBytes?: number;
};

function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function createVaultRoutes(options: VaultRoutesOptions): Hono<{ Variables: BodyLimitVariables }> {
  const app = new Hono<{ Variables: BodyLimitVariables }>();

  const maxVaultBytes = options.maxVaultBytes ?? DEFAULT_MAX_VAULT_BYTES;

  /** 保存済み暗号文の総量（UTF-8 のバイト数）を数える。 */
  async function storedBytes(): Promise<number> {
    const rows = await options.db
      .select({ total: sql<number>`coalesce(sum(length(cast(${vaults.envelope} as blob))), 0)` })
      .from(vaults);
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * 認可: vaultId がトークンから導出でき、かつ tokenHash が一致したときのみ。
   * 不一致は 404（ボルトの存在を漏らさない）。
   */
  async function authorize(id: string, authorization: string | undefined) {
    if (!isValidVaultId(id)) return null;
    const token = bearerToken(authorization);
    if (token === null || token.length < 32) return null;
    // 仕様: vaultId = hex(SHA-256(token))[0:32]。ID を任意に選べないようにする。
    if ((await deriveVaultId(token)) !== id) return null;
    const rows = await options.db.select().from(vaults).where(eq(vaults.id, id)).limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const hash = await deriveTokenHash(token);
    if (!timingSafeEqualString(hash, row.tokenHash)) return null;
    return row;
  }

  app.get('/:id', async (c) => {
    const row = await authorize(c.req.param('id'), c.req.header('authorization'));
    if (row === null) return c.json({ error: 'not_found' }, 404);
    let envelope: unknown;
    try {
      envelope = JSON.parse(row.envelope) as unknown;
    } catch {
      // 破損した行は 500 ではなく明示的なエラーにする（クライアントが復旧判断できる）。
      return c.json({ error: 'corrupt_vault' }, 409);
    }
    return c.json({ envelope, revision: row.revision });
  });

  app.get('/:id/meta', async (c) => {
    const row = await authorize(c.req.param('id'), c.req.header('authorization'));
    if (row === null) return c.json({ error: 'not_found' }, 404);
    return c.json({ revision: row.revision, updatedAt: row.updatedAt });
  });

  app.put('/:id', async (c) => {
    const id = c.req.param('id');
    if (!isValidVaultId(id)) {
      return c.json({ error: 'invalid_vault_id' }, 400);
    }
    const rawBody = c.get('rawBody');
    if (rawBody === undefined) {
      return c.json({ error: 'invalid_body' }, 400);
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = putBodySchema.safeParse(parsedJson);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues.map((i) => i.path.join('.')) }, 400);
    }
    const { envelope, revision } = parsed.data;

    // body の revision は「クライアントが現在保持している revision」（楽観ロックの基準）。
    // envelope.revision は「書き込み後の新しい revision」。
    if (envelope.revision <= revision) {
      return c.json({ error: 'revision_must_advance' }, 400);
    }

    const token = bearerToken(c.req.header('authorization'));
    if (token === null || token.length < 32) {
      return c.json({ error: 'not_found' }, 404);
    }
    // 仕様: vaultId = hex(SHA-256(token))[0:32]。導出できない ID は受け付けない
    // （未認証の第三者が任意の ID で行を作る／名前空間を占有するのを防ぐ）。
    if ((await deriveVaultId(token)) !== id) {
      return c.json({ error: 'not_found' }, 404);
    }
    const tokenHash = await deriveTokenHash(token);

    const existing = (await options.db.select().from(vaults).where(eq(vaults.id, id)).limit(1))[0];
    const now = new Date().toISOString();

    // 上限はバイト数で揃える（SQLite の TEXT 長は文字数なので BLOB として数える）。
    const incomingBytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
    if (existing === undefined) {
      if ((await storedBytes()) + incomingBytes > maxVaultBytes) {
        return c.json({ error: 'storage_limit' }, 507);
      }
      await options.db.insert(vaults).values({
        id,
        tokenHash,
        envelope: JSON.stringify(envelope),
        revision: envelope.revision,
        createdAt: now,
        updatedAt: now,
      });
      return c.json({ revision: envelope.revision });
    }

    if (!timingSafeEqualString(existing.tokenHash, tokenHash)) {
      // 既存ボルトへの別トークンでの書き込みは存在を漏らさず 404。
      return c.json({ error: 'not_found' }, 404);
    }
    if (existing.revision !== revision) {
      return c.json({ error: 'conflict', currentRevision: existing.revision }, 409);
    }
    const existingBytes = Buffer.byteLength(existing.envelope, 'utf8');
    if ((await storedBytes()) - existingBytes + incomingBytes > maxVaultBytes) {
      return c.json({ error: 'storage_limit' }, 507);
    }

    await options.db
      .update(vaults)
      .set({ envelope: JSON.stringify(envelope), revision: envelope.revision, updatedAt: now })
      .where(eq(vaults.id, id));
    return c.json({ revision: envelope.revision });
  });

  app.delete('/:id', async (c) => {
    const row = await authorize(c.req.param('id'), c.req.header('authorization'));
    if (row === null) return c.json({ error: 'not_found' }, 404);
    await options.db.delete(vaults).where(eq(vaults.id, row.id));
    return c.body(null, 204);
  });

  return app;
}
