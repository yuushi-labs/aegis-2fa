import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app';
import { createDatabase, type DatabaseHandle } from '../../server/db/client';
import { runMigrations } from '../../server/db/migrate';
import { createVaultEnvelope, unlockVaultEnvelope } from '../../shared/crypto';
import { deriveTokenHash, deriveVaultId, generateSyncToken } from '../../shared/sync';
import { generateTOTP } from '../../shared/totp';
import { encodeBase32 } from '../../shared/base32';
import type { VaultEnvelope } from '../../shared/types';

const SECRET_BASE32 = encodeBase32(new TextEncoder().encode('12345678901234567890'));
const MASTER_PASSWORD = 'integration-test-password';

let workDir: string;
let database: DatabaseHandle;
let app: ReturnType<typeof createApp>;

function buildEnvelope(revision: number, secret = SECRET_BASE32): Promise<VaultEnvelope> {
  return createVaultEnvelope({
    password: MASTER_PASSWORD,
    plaintext: JSON.stringify({ accounts: [{ id: 'a1', secret, label: 'test@example.com' }] }),
    revision,
  });
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'aegis-int-'));
  database = createDatabase(join(workDir, 'test.db'));
  runMigrations(database);
  app = createApp({ database, disableRateLimit: true, log: () => {} });
});

afterEach(() => {
  database.close();
  rmSync(workDir, { recursive: true, force: true });
});

async function setupVault(): Promise<{ id: string; token: string; envelope: VaultEnvelope }> {
  const token = generateSyncToken();
  const id = await deriveVaultId(token);
  const envelope = await buildEnvelope(1);
  const response = await app.request(`/api/vault/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ envelope, revision: 0 }),
  });
  expect(response.status).toBe(200);
  return { id, token, envelope };
}

describe('GET /api/health', () => {
  it('200 で status/uptime/version を返す', async () => {
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; uptime: number; version: string; database: string };
    expect(body.status).toBe('ok');
    expect(body.database).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(body.version).toBe('1.0.0');
  });
});

describe('ボルト API の一連の流れ', () => {
  it('PUT → GET → meta → DELETE', async () => {
    const { id, token, envelope } = await setupVault();

    const get = await app.request(`/api/vault/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as { envelope: VaultEnvelope; revision: number };
    expect(getBody.revision).toBe(1);
    expect(getBody.envelope.format).toBe('aegis-vault');
    expect(getBody.envelope.data.ciphertext).toBe(envelope.data.ciphertext);

    const meta = await app.request(`/api/vault/${id}/meta`, { headers: { Authorization: `Bearer ${token}` } });
    expect(meta.status).toBe(200);
    const metaBody = (await meta.json()) as { revision: number; updatedAt: string };
    expect(metaBody.revision).toBe(1);
    expect(Number.isNaN(Date.parse(metaBody.updatedAt))).toBe(false);

    const del = await app.request(`/api/vault/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(del.status).toBe(204);

    const afterDelete = await app.request(`/api/vault/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(afterDelete.status).toBe(404);
  });

  it('revision を進めて更新できる（body.revision は基準 revision）', async () => {
    const { id, token } = await setupVault();
    const next = await buildEnvelope(2, encodeBase32(new TextEncoder().encode('abcdefghijklmnopqrst')));
    const put = await app.request(`/api/vault/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ envelope: next, revision: 1 }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { revision: number }).revision).toBe(2);
  });

  it('revision 不一致は 409 と currentRevision', async () => {
    const { id, token } = await setupVault();
    const stale = await buildEnvelope(5);
    const put = await app.request(`/api/vault/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ envelope: stale, revision: 4 }),
    });
    expect(put.status).toBe(409);
    expect((await put.json()) as { currentRevision: number }).toMatchObject({ currentRevision: 1 });
  });

  it('トークン不一致は 404（存在を漏らさない）', async () => {
    const { id } = await setupVault();
    const otherToken = generateSyncToken();
    const get = await app.request(`/api/vault/${id}`, { headers: { Authorization: `Bearer ${otherToken}` } });
    expect(get.status).toBe(404);
    const del = await app.request(`/api/vault/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${otherToken}` },
    });
    expect(del.status).toBe(404);
    const meta = await app.request(`/api/vault/${id}/meta`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    });
    expect(meta.status).toBe(404);
  });

  it('Authorization が無い場合は 404', async () => {
    const { id } = await setupVault();
    expect((await app.request(`/api/vault/${id}`)).status).toBe(404);
    expect((await app.request(`/api/vault/${id}/meta`)).status).toBe(404);
  });

  it('既存ボルトへ別トークンで PUT しても 404', async () => {
    const { id } = await setupVault();
    const envelope = await buildEnvelope(1);
    const put = await app.request(`/api/vault/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${generateSyncToken()}` },
      body: JSON.stringify({ envelope, revision: 0 }),
    });
    expect(put.status).toBe(404);
  });

  it('存在しないボルトは 404', async () => {
    const id = 'a'.repeat(32);
    const response = await app.request(`/api/vault/${id}`, { headers: { Authorization: `Bearer ${generateSyncToken()}` } });
    expect(response.status).toBe(404);
  });
});

describe('入力バリデーション', () => {
  it('id 形式不正は 400', async () => {
    const put = await app.request('/api/vault/NOT-A-VALID-ID', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${generateSyncToken()}` },
      body: JSON.stringify({ envelope: await buildEnvelope(1), revision: 0 }),
    });
    expect(put.status).toBe(400);
    expect(((await put.json()) as { error: string }).error).toBe('invalid_vault_id');
  });

  it('壊れた JSON は 400', async () => {
    const token = generateSyncToken();
    const id = await deriveVaultId(token);
    const put = await app.request(`/api/vault/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{"envelope":',
    });
    expect(put.status).toBe(400);
  });

  it('envelope の必須フィールド欠落は 400', async () => {
    const token = generateSyncToken();
    const id = await deriveVaultId(token);
    const put = await app.request(`/api/vault/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ envelope: { format: 'aegis-vault' }, revision: 1 }),
    });
    expect(put.status).toBe(400);
    expect(((await put.json()) as { error: string }).error).toBe('invalid_body');
  });

  it('revision が負数なら 400', async () => {
    const token = generateSyncToken();
    const id = await deriveVaultId(token);
    const envelope = await buildEnvelope(1);
    const put = await app.request(`/api/vault/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ envelope: { ...envelope, revision: -1 }, revision: -1 }),
    });
    expect(put.status).toBe(400);
  });

  it('envelope.revision が基準 revision 以下なら 400', async () => {
    const { id, token } = await setupVault();
    const envelope = await buildEnvelope(1);
    const put = await app.request(`/api/vault/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ envelope, revision: 1 }),
    });
    expect(put.status).toBe(400);
    expect(((await put.json()) as { error: string }).error).toBe('revision_must_advance');
  });

  it('Content-Length の無い chunked body でも上限超過は 413', async () => {
    const token = generateSyncToken();
    const id = await deriveVaultId(token);
    // ストリームで送る → Content-Length は付かない。
    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 320 * 1024) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const request = new Request(`http://localhost/api/vault/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    const response = await app.request(request);
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: string }).error).toBe('payload_too_large');
  });

  it('Content-Length の無い小さな body はそのまま処理される', async () => {
    const token = generateSyncToken();
    const id = await deriveVaultId(token);
    const payload = new TextEncoder().encode(JSON.stringify({ envelope: await buildEnvelope(1), revision: 0 }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    const request = new Request(`http://localhost/api/vault/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    const response = await app.request(request);
    expect(response.status).toBe(200);
  });

  it('body が 256 KiB を超えると 413', async () => {
    const token = generateSyncToken();
    const id = await deriveVaultId(token);
    const huge = 'x'.repeat(300 * 1024);
    const put = await app.request(`/api/vault/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ envelope: { pad: huge }, revision: 1 }),
    });
    expect(put.status).toBe(413);
    expect(((await put.json()) as { error: string }).error).toBe('payload_too_large');
  });
});

describe('セキュリティヘッダ', () => {
  it('全レスポンスに CSP ほかが付く', async () => {
    const paths: [string, RequestInit][] = [
      ['/api/health', {}],
      ['/api/vault/' + 'a'.repeat(32), { headers: { Authorization: `Bearer ${generateSyncToken()}` } }],
      ['/api/unknown', {}],
    ];
    for (const [path, init] of paths) {
      const response = await app.request(path, init);
      const csp = response.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('permissions-policy')).toContain('camera=(self)');
      expect(response.headers.get('permissions-policy')).toContain('microphone=()');
      expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    }
  });

  it('/api/* は Cache-Control: no-store', async () => {
    const response = await app.request('/api/health');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('HTTPS 指定時のみ HSTS を付ける', async () => {
    const httpsApp = createApp({ database, disableRateLimit: true, log: () => {}, https: true });
    const secure = await httpsApp.request('/api/health');
    expect(secure.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    const plain = await app.request('/api/health');
    expect(plain.headers.get('strict-transport-security')).toBeNull();
  });
});

describe('レート制限', () => {
  it('60 req/min を超えると 429 と Retry-After', async () => {
    let clock = 1_000_000;
    const limitedApp = createApp({ database, log: () => {}, now: () => clock });
    const id = 'b'.repeat(32);
    let response: Response | null = null;
    for (let i = 0; i < 61; i += 1) {
      response = await limitedApp.request(`/api/vault/${id}/meta`, {
        headers: { Authorization: `Bearer ${generateSyncToken()}` },
      });
    }
    expect(response?.status).toBe(429);
    expect(Number(response?.headers.get('retry-after'))).toBeGreaterThan(0);
    clock += 61_000;
    const recovered = await limitedApp.request(`/api/vault/${id}/meta`, {
      headers: { Authorization: `Bearer ${generateSyncToken()}` },
    });
    expect(recovered.status).toBe(404);
  });

  it('既定（TRUST_PROXY なし）では転送ヘッダを変えても制限を回避できない', async () => {
    const limitedApp = createApp({ database, log: () => {} });
    const id = 'c'.repeat(32);
    let response: Response | null = null;
    for (let i = 0; i < 61; i += 1) {
      response = await limitedApp.request(`/api/vault/${id}/meta`, {
        headers: { Authorization: `Bearer ${generateSyncToken()}`, 'X-Forwarded-For': `10.0.0.${i}` },
      });
    }
    expect(response?.status).toBe(429);
  });

  it('TRUST_PROXY=true なら転送ヘッダ単位で数える', async () => {
    const limitedApp = createApp({ database, log: () => {}, trustProxy: true });
    const id = 'd'.repeat(32);
    for (let i = 0; i < 61; i += 1) {
      const response = await limitedApp.request(`/api/vault/${id}/meta`, {
        headers: { Authorization: `Bearer ${generateSyncToken()}`, 'X-Forwarded-For': `10.0.1.${i}` },
      });
      expect(response.status).toBe(404);
    }
    // 同じ IP を繰り返せば制限される。
    let last: Response | null = null;
    for (let i = 0; i < 61; i += 1) {
      last = await limitedApp.request(`/api/vault/${id}/meta`, {
        headers: { Authorization: `Bearer ${generateSyncToken()}`, 'X-Forwarded-For': '10.0.2.1' },
      });
    }
    expect(last?.status).toBe(429);
  });

  it('PUT は 20 req/min で制限される', async () => {
    const limitedApp = createApp({ database, log: () => {} });
    const token = generateSyncToken();
    const id = await deriveVaultId(token);
    const envelope = await buildEnvelope(1);
    let response: Response | null = null;
    for (let i = 0; i < 21; i += 1) {
      response = await limitedApp.request(`/api/vault/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ envelope, revision: 0 }),
      });
    }
    expect(response?.status).toBe(429);
  });
});

describe('ゼロ知識（サーバーは平文を知らない）', () => {
  it('PUT された封筒に秘密鍵もパスワードも平文で含まれない', async () => {
    const { id, token, envelope } = await setupVault();
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain(SECRET_BASE32);
    expect(serialized).not.toContain(MASTER_PASSWORD);

    const get = await app.request(`/api/vault/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    const raw = await get.text();
    expect(raw).not.toContain(SECRET_BASE32);
    expect(raw).not.toContain(MASTER_PASSWORD);
    // クライアントが復号できること（サーバーは復号できない）。
    const body = JSON.parse(raw) as { envelope: VaultEnvelope };
    const unlocked = await unlockVaultEnvelope(body.envelope, MASTER_PASSWORD);
    expect(unlocked.plaintext).toContain(SECRET_BASE32);
  });

  it('サーバー DB ファイルに平文 secret が現れない', async () => {
    const { id, token } = await setupVault();
    // WAL をチェックポイントしてからファイル全体を検査する。
    database.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    const files = [`${database.path}`, `${database.path}-wal`, `${database.path}-shm`];
    for (const file of files) {
      let content = '';
      try {
        content = readFileSync(file, 'latin1');
      } catch {
        continue;
      }
      expect(content).not.toContain(SECRET_BASE32);
      expect(content).not.toContain(MASTER_PASSWORD);
    }
    // 暗号文は存在する。
    const row = await database.sqlite.prepare('select envelope from vaults where id = ?').get(id) as
      | { envelope: string }
      | undefined;
    expect(row?.envelope).toContain('aegis-vault');
    expect(token).toBeTruthy();
  });

  it('サーバーは tokenHash のみ保存し、トークン本体は保存しない', async () => {
    const { id, token } = await setupVault();
    database.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    const row = await database.sqlite.prepare('select token_hash from vaults where id = ?').get(id) as
      | { token_hash: string }
      | undefined;
    expect(row?.token_hash).toBe(await deriveTokenHash(token));
    expect(row?.token_hash).not.toBe(token);
    const content = readFileSync(database.path, 'latin1');
    expect(content).not.toContain(token);
  });

  it('サーバーに送った暗号文は OTP コードを導出できない（復号鍵が無い）', async () => {
    const { envelope } = await setupVault();
    const serialized = JSON.stringify(envelope);
    const expectedCode = await generateTOTP(SECRET_BASE32, 1_700_000_000);
    expect(serialized).not.toContain(expectedCode);
    expect(serialized).not.toContain(SECRET_BASE32);
  });
});

describe('ログに秘密情報を出さない', () => {
  it('Authorization もボディもログに出ない', async () => {
    const lines: string[] = [];
    const loggedApp = createApp({ database, disableRateLimit: true, log: (line) => lines.push(line) });
    const token = generateSyncToken();
    const id = await deriveVaultId(token);
    const envelope = await buildEnvelope(1);
    await loggedApp.request(`/api/vault/${id}?token=${token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ envelope, revision: 0 }),
    });
    const joined = lines.join('\n');
    expect(joined).not.toContain(token);
    expect(joined).not.toContain(SECRET_BASE32);
    expect(joined).not.toContain(MASTER_PASSWORD);
    expect(joined).not.toContain('authorization');
    expect(joined).not.toContain('token=');
    expect(joined).toMatch(/PUT \/api\/vault\/[0-9a-f]{32} 200/);
  });
});

describe('SPA フォールバック', () => {
  it('静的ルート未指定なら 404 の簡易ページ', async () => {
    const response = await app.request('/some/deep/link');
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('Aegis 2FA');
  });

  it('dist があれば index.html を返し、未知の /api/* は JSON 404', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const distDir = join(workDir, 'dist');
    mkdirSync(join(distDir, 'assets'), { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>SPA</title>');
    writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log(1)');
    const spaApp = createApp({ database, disableRateLimit: true, log: () => {}, staticRoot: distDir });

    const root = await spaApp.request('/');
    expect(root.status).toBe(200);
    expect(root.headers.get('cache-control')).toBe('no-store');

    const deep = await spaApp.request('/accounts/123');
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('SPA');

    const asset = await spaApp.request('/assets/app.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');

    // index.html を直接取得しても no-store（古いハッシュ付き資産を参照しない）。
    const direct = await spaApp.request('/index.html');
    expect(direct.status).toBe(200);
    expect(direct.headers.get('cache-control')).toBe('no-store');

    const api = await spaApp.request('/api/does-not-exist');
    expect(api.status).toBe(404);
    expect(((await api.json()) as { error: string }).error).toBe('not_found');

    const traversal = await spaApp.request('/../package.json');
    expect(traversal.status).toBe(200);
    expect(await traversal.text()).toContain('SPA');
  });
});

describe('保存の境界と整合性', () => {
  it('id がトークンから導出できない場合は 404（任意 ID の行を作らせない）', async () => {
    const token = generateSyncToken();
    const unrelatedId = 'deadbeefdeadbeefdeadbeefdeadbeef';
    const envelope = await buildEnvelope(1);
    const response = await app.request(`/api/vault/${unrelatedId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ envelope, revision: 0 }),
    });
    expect(response.status).toBe(404);
    const read = await app.request(`/api/vault/${unrelatedId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(read.status).toBe(404);
  });

  it('保存量が上限を超える新規作成は 507 で、行を作らない', async () => {
    const limitApp = createApp({
      database,
      disableRateLimit: true,
      log: () => {},
      maxVaultBytes: 10,
    });
    const token = generateSyncToken();
    const id = await deriveVaultId(token);
    const envelope = await buildEnvelope(1);
    const response = await limitApp.request(`/api/vault/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ envelope, revision: 0 }),
    });
    expect(response.status).toBe(507);
    expect(((await response.json()) as { error: string }).error).toBe('storage_limit');
    const read = await limitApp.request(`/api/vault/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(read.status).toBe(404);
  });

  it('壊れた封筒は 500 ではなく 409 corrupt_vault を返す', async () => {
    const token = generateSyncToken();
    const id = await deriveVaultId(token);
    const tokenHash = await deriveTokenHash(token);
    const now = new Date().toISOString();
    const { vaults } = await import('../../server/db/schema');
    await database.db.insert(vaults).values({
      id,
      tokenHash,
      envelope: '{not json',
      revision: 2,
      createdAt: now,
      updatedAt: now,
    });
    const response = await app.request(`/api/vault/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('corrupt_vault');
  });
});
