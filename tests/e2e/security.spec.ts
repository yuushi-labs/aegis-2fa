import { test, expect } from './helpers';

test.describe('サーバー配信のセキュリティヘッダ', () => {
  test('HTML レスポンスに CSP・nosniff・frame 拒否が付く', async ({ request }) => {
    const response = await request.get('/');
    expect(response.status()).toBe(200);
    const headers = response.headers();
    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-eval');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('no-referrer');
  });

  test('API レスポンスは no-store でキャッシュされない', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('no-store');
    const body = (await response.json()) as { status?: string };
    expect(body.status).toBe('ok');
  });

  test('存在しないボルトは 404 を返し、他者データを漏らさない', async ({ request }) => {
    const response = await request.get('/api/vault/0123456789abcdef0123456789abcdef', {
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect([401, 403, 404]).toContain(response.status());
    const text = await response.text();
    expect(text).not.toContain('secret');
  });

  test('不正な JSON ボディは 400 で拒否される', async ({ request }) => {
    const response = await request.put('/api/vault/0123456789abcdef0123456789abcdef', {
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-real-token' },
      data: '{"broken":',
    });
    expect([400, 401, 403]).toContain(response.status());
  });

  test('外部オリジンへの preflight は許可されない', async ({ request }) => {
    const response = await request.fetch('/api/vault/0123456789abcdef0123456789abcdef', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'PUT',
      },
    });
    const allow = response.headers()['access-control-allow-origin'];
    expect(allow ?? '').not.toBe('https://evil.example');
    expect(allow ?? '').not.toBe('*');
  });
});
