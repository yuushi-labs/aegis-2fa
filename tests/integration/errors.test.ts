import { describe, expect, it } from 'vitest';
import { createApp } from '../../server/app';
import type { DatabaseHandle } from '../../server/db/client';
import { CSP_DIRECTIVES } from '../../server/middleware/security';
import { deriveVaultId } from '../../shared/sync';

/** どのクエリでも例外を投げる DB（500 応答の経路を作るため）。 */
function failingDatabase(): DatabaseHandle {
  const fail = (): never => {
    throw new Error('database unavailable');
  };
  return {
    db: { select: fail } as unknown as DatabaseHandle['db'],
    sqlite: { close: () => undefined } as unknown as DatabaseHandle['sqlite'],
    path: ':memory:',
    close: () => undefined,
  };
}

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

describe('例外時の応答', () => {
  it('500 でもセキュリティヘッダと no-store を付ける', async () => {
    const app = createApp({ database: failingDatabase(), disableRateLimit: true, log: () => {} });
    const vaultId = await deriveVaultId(TOKEN);
    const response = await app.request(`/api/vault/${vaultId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(500);
    expect(response.headers.get('content-security-policy')).toBe(CSP_DIRECTIVES);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('internal_error');
  });

  it('500 の本文に内部情報を出さない（本番モード）', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const app = createApp({ database: failingDatabase(), disableRateLimit: true, log: () => {} });
      const vaultId = await deriveVaultId(TOKEN);
      const response = await app.request(`/api/vault/${vaultId}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe('internal_error');
      expect(body.message).not.toContain('database unavailable');
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
