/**
 * /api/vault/* — 暗号文の保存のみ。認可は Bearer トークンの SHA-256 一致。
 *
 * レスポンスに平文の秘密鍵・パスワードは決して含めない（そもそも受け取らない）。
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { timingSafeEqualString } from '../../shared/encoding';
import { deriveTokenHash, isValidVaultId } from '../../shared/sync';
import { vaults } from '../db/schema';
import type { AegisDatabase } from '../db/client';
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
      iterations: z.number().int().min(100_000).max(10_000_000),
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

export type VaultRoutesOptions = {
  db: AegisDatabase;
};

function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function createVaultRoutes(options: VaultRoutesOptions): Hono<{ Variables: BodyLimitVariables }> {
  const app = new Hono<{ Variables: BodyLimitVariables }>();

  /** 認可: vaultId と tokenHash の両方が一致したときのみ。不一致は 404。 */
  async function authorize(id: string, authorization: string | undefined) {
    if (!isValidVaultId(id)) return null;
    const token = bearerToken(authorization);
    if (token === null || token.length < 32) return null;
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
    return c.json({
      envelope: JSON.parse(row.envelope) as unknown,
      revision: row.revision,
    });
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
    const tokenHash = await deriveTokenHash(token);

    const existing = (await options.db.select().from(vaults).where(eq(vaults.id, id)).limit(1))[0];
    const now = new Date().toISOString();

    if (existing === undefined) {
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
