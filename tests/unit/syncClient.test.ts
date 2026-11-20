import { describe, expect, it, vi } from 'vitest';
import {
  createSyncClient,
  SyncConflictError,
  SyncHttpError,
  SyncNotFoundError,
} from '../../src/lib/syncClient';
import type { VaultEnvelope } from '../../shared/types';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const ENVELOPE = {
  format: 'aegis-vault',
  version: 1,
  kdf: { name: 'PBKDF2-SHA256', iterations: 600_000, salt: 'c2FsdA==' },
  wrappedKey: { iv: 'aXY=', ciphertext: 'd3JhcHBlZA==' },
  data: { iv: 'aXY=', ciphertext: 'ZGF0YQ==' },
  verifier: 'dmVyaWZpZXI=',
  revision: 3,
  updatedAt: '2026-01-01T00:00:00.000Z',
} satisfies VaultEnvelope;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('同期 API クライアント', () => {
  it('get は Authorization 付きで取得し、封筒と revision を返す', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ envelope: ENVELOPE, revision: 3 }));
    const client = createSyncClient({ baseUrl: '/base', fetchImpl });
    await expect(client.get('vault-id', TOKEN)).resolves.toEqual({ envelope: ENVELOPE, revision: 3 });
    expect(fetchImpl).toHaveBeenCalledWith('/base/api/vault/vault-id', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  });

  it('get は 404 を SyncNotFoundError にする', async () => {
    const client = createSyncClient({
      fetchImpl: async () => jsonResponse({ error: 'not_found' }, 404),
    });
    await expect(client.get('vault-id', TOKEN)).rejects.toBeInstanceOf(SyncNotFoundError);
  });

  it('get はその他の失敗をステータス付きの SyncHttpError にする', async () => {
    const client = createSyncClient({
      fetchImpl: async () => jsonResponse({ error: 'boom' }, 500),
    });
    const error = await client.get('vault-id', TOKEN).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SyncHttpError);
    expect((error as SyncHttpError).status).toBe(500);
    expect((error as SyncHttpError).body).toEqual({ error: 'boom' });
  });

  it('getMeta は revision と更新時刻だけを返す', async () => {
    const client = createSyncClient({
      fetchImpl: async () =>
        jsonResponse({ revision: 9, updatedAt: '2026-02-01T00:00:00.000Z' }),
    });
    await expect(client.getMeta('vault-id', TOKEN)).resolves.toEqual({
      revision: 9,
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
  });

  it('put は base revision を本文に載せ、次の revision を受け取る', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ revision: 5 }),
    );
    const client = createSyncClient({ fetchImpl });
    const envelope = { ...ENVELOPE, revision: 4 };
    await expect(client.put('vault-id', TOKEN, envelope, 3)).resolves.toEqual({ revision: 5 });
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.method).toBe('PUT');
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    });
    // 封筒の revision（書き込み後の値）と base revision（楽観ロックの基準）は別物。
    expect(JSON.parse(String(init?.body))).toEqual({ envelope, revision: 3 });
  });

  it('put は 404 を SyncNotFoundError にする（サーバー側で消えている）', async () => {
    const client = createSyncClient({
      fetchImpl: async () => jsonResponse({ error: 'not_found' }, 404),
    });
    await expect(client.put('vault-id', TOKEN, ENVELOPE, 1)).rejects.toBeInstanceOf(
      SyncNotFoundError,
    );
  });

  it('put は 409 を現在の revision 付きの SyncConflictError にする', async () => {
    const client = createSyncClient({
      fetchImpl: async () => jsonResponse({ error: 'conflict', currentRevision: 7 }, 409),
    });
    const error = await client.put('vault-id', TOKEN, ENVELOPE, 3).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SyncConflictError);
    expect((error as SyncConflictError).currentRevision).toBe(7);
  });

  it('put の 409 本文に revision が無ければ送信時の base を使う', async () => {
    const client = createSyncClient({
      fetchImpl: async () => new Response('not json', { status: 409 }),
    });
    const error = await client.put('vault-id', TOKEN, ENVELOPE, 5).catch((reason: unknown) => reason);
    expect((error as SyncConflictError).currentRevision).toBe(5);
  });

  it('remove は 404 を成功として扱う（既に消えている）', async () => {
    const client = createSyncClient({ fetchImpl: async () => jsonResponse(null, 404) });
    await expect(client.remove('vault-id', TOKEN)).resolves.toBeUndefined();
  });

  it('remove はその他の失敗を投げる', async () => {
    const client = createSyncClient({ fetchImpl: async () => jsonResponse(null, 503) });
    await expect(client.remove('vault-id', TOKEN)).rejects.toBeInstanceOf(SyncHttpError);
  });

  it('health は成否を真偽値で返し、通信失敗は false', async () => {
    const okClient = createSyncClient({ fetchImpl: async () => jsonResponse({ ok: true }) });
    await expect(okClient.health()).resolves.toBe(true);
    const brokenClient = createSyncClient({
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    await expect(brokenClient.health()).resolves.toBe(false);
    const failingClient = createSyncClient({
      fetchImpl: async () => jsonResponse({ ok: false }, 500),
    });
    await expect(failingClient.health()).resolves.toBe(false);
  });
});
