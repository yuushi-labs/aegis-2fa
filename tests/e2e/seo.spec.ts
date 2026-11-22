import type { Page } from '@playwright/test';
import { test, expect, createVault } from './helpers';

/**
 * SEO・共有カード・クロール制御の E2E。
 *
 * 検索エンジンと SNS が見るのは「配信中の index.html / robots.txt / sitemap.xml」なので、
 * ここでは実際に配信されたものを読む。JSON-LD を入れたことで CSP（script-src 'self'）に
 * 違反が出ていないことも、コンソールエラーが無いことで確かめる。
 */

/** ビルド時の公開オリジン（VITE_SITE_ORIGIN 未指定なら本番の Xserver）。 */
const SITE_ORIGIN = process.env.VITE_SITE_ORIGIN ?? 'https://yuushi0911.xsrv.jp';

/** ページの meta / link を読む。 */
async function meta(page: Page, selector: string): Promise<string | null> {
  return page.evaluate((query) => document.querySelector(query)?.getAttribute('content') ?? null, selector);
}

test.describe('SEO メタデータ', () => {
  test('title・description・robots・canonical が検索向けに揃っている', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle(/2段階認証/);
    const title = await page.title();
    expect(title).toContain('Aegis 2FA');
    // 検索結果で切れにくい長さ（全角換算でおよそ 60 文字以内）。
    expect(title.length).toBeGreaterThan(10);
    expect(title.length).toBeLessThanOrEqual(70);

    const description = await meta(page, 'meta[name="description"]');
    expect(description).toContain('2段階認証');
    expect(description).toContain('ゼロ知識');
    expect(description).toContain('TOTP');
    expect(description).toContain('パスキー');
    expect(description?.length ?? 0).toBeGreaterThan(70);
    expect(description?.length ?? 0).toBeLessThanOrEqual(160);

    expect(await meta(page, 'meta[name="robots"]')).toBe('index, follow');

    const canonical = await page.evaluate(
      () => document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
    );
    expect(canonical).toBe(`${SITE_ORIGIN}/`);
  });

  test('OGP と Twitter Card が絶対 URL で入っている', async ({ page }) => {
    await page.goto('/');

    expect(await meta(page, 'meta[property="og:type"]')).toBe('website');
    expect(await meta(page, 'meta[property="og:site_name"]')).toBe('Aegis 2FA');
    expect(await meta(page, 'meta[property="og:title"]')).toContain('Aegis 2FA');
    expect(await meta(page, 'meta[property="og:description"]')).toContain('秘密鍵');
    expect(await meta(page, 'meta[property="og:url"]')).toBe(`${SITE_ORIGIN}/`);
    expect(await meta(page, 'meta[property="og:locale"]')).toBe('ja_JP');
    expect(await meta(page, 'meta[property="og:image"]')).toBe(`${SITE_ORIGIN}/og-image.png`);
    expect(await meta(page, 'meta[property="og:image:width"]')).toBe('1200');
    expect(await meta(page, 'meta[property="og:image:height"]')).toBe('630');
    expect(await meta(page, 'meta[property="og:image:alt"]')).toBeTruthy();

    expect(await meta(page, 'meta[name="twitter:card"]')).toBe('summary_large_image');
    expect(await meta(page, 'meta[name="twitter:title"]')).toContain('Aegis 2FA');
    expect(await meta(page, 'meta[name="twitter:image"]')).toBe(`${SITE_ORIGIN}/og-image.png`);
  });

  test('JSON-LD（SoftwareApplication）が有効な JSON として埋め込まれている', async ({ page }) => {
    await page.goto('/');

    const blocks = await page.evaluate(() =>
      [...document.querySelectorAll('script[type="application/ld+json"]')].map((node) => node.textContent ?? ''),
    );
    expect(blocks).toHaveLength(1);

    const data = JSON.parse(blocks[0] ?? '{}') as Record<string, unknown>;
    expect(data['@context']).toBe('https://schema.org');
    expect(data['@type']).toBe('SoftwareApplication');
    expect(data.name).toBe('Aegis 2FA');
    expect(data.applicationCategory).toBe('SecurityApplication');
    expect(String(data.operatingSystem)).toContain('Web');
    expect(String(data.operatingSystem)).toContain('Android');
    expect(String(data.description)).toContain('ゼロ知識');
    expect(data.url).toBe(`${SITE_ORIGIN}/`);
    expect(data.isAccessibleForFree).toBe(true);
    expect(data.inLanguage).toBe('ja');
    const offers = data.offers as Record<string, unknown>;
    expect(offers.price).toBe('0');
    expect(Array.isArray(data.featureList)).toBe(true);
    expect((data.featureList as unknown[]).length).toBeGreaterThanOrEqual(5);
  });

  test('JSON-LD を入れてもコンソールエラー・CSP 違反が出ない', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

    await page.goto('/');
    // アプリが描画されるまで待つ（初期化の途中で落ちていないこと）。
    await expect(page.getByRole('heading', { name: 'ボルトをつくる' })).toBeVisible();

    expect(errors).toEqual([]);
  });
});

test.describe('画面ごとのタイトル', () => {
  test('プライバシーポリシーと各画面でタイトルが切り替わる', async ({ page }) => {
    await page.goto('/privacy');
    await expect(page.getByTestId('privacy-page')).toBeVisible();
    await expect(page).toHaveTitle(/^プライバシーポリシー \| Aegis 2FA/);

    await page.goto('/');
    await expect(page).toHaveTitle(/^ボルトをつくる \| Aegis 2FA/);

    await createVault(page, { sync: false });
    await expect(page).toHaveTitle(/^Aegis 2FA — ゼロ知識E2EEの2段階認証アプリ$/);

    await page.getByRole('link', { name: '設定', exact: true }).click();
    await expect(page.getByRole('heading', { name: '設定' })).toBeVisible();
    await expect(page).toHaveTitle(/^設定 \| Aegis 2FA/);

    await page.getByRole('link', { name: 'Aegis' }).click();
    await expect(page).toHaveTitle(/^Aegis 2FA — ゼロ知識E2EEの2段階認証アプリ$/);
    await page.getByRole('link', { name: '追加', exact: true }).click();
    await expect(page).toHaveTitle(/^アカウントを追加 \| Aegis 2FA/);

    // 解錠前の画面は「いま何を求められているか」をタイトルにする。
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'ロック中' })).toBeVisible();
    await expect(page).toHaveTitle(/^ロック中 \| Aegis 2FA/);
  });
});

test.describe('クロール制御とサイトマップ', () => {
  test('robots.txt は全体を許可し、API だけを除外する', async ({ request }) => {
    const response = await request.get('/robots.txt');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type'] ?? '').toContain('text/plain');

    const body = await response.text();
    expect(body).toContain('User-agent: *');
    expect(body).toContain('Allow: /');
    expect(body).toContain('Disallow: /api/');
    expect(body).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
    // 検索エンジンを丸ごと止める行が残っていないこと。
    expect(body).not.toMatch(/^Disallow: \/$/m);
  });

  test('sitemap.xml が XML として配信され、公開ページを列挙する', async ({ request }) => {
    const response = await request.get('/sitemap.xml');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type'] ?? '').toContain('xml');

    const body = await response.text();
    expect(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(body).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    expect(body).toContain(`<loc>${SITE_ORIGIN}/</loc>`);
    expect(body).toContain(`<loc>${SITE_ORIGIN}/privacy</loc>`);
    expect(body.match(/<url>/g)).toHaveLength(2);
  });

  test('og-image.png が 1200x630 の PNG で配信される', async ({ request }) => {
    const response = await request.get('/og-image.png');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type'] ?? '').toBe('image/png');

    const png = await response.body();
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    // IHDR の幅・高さ（バイト 16..24）。
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    expect(png.byteLength).toBeGreaterThan(10_000);
  });

  test('JavaScript 無効でも概要と主な特徴が読める（noscript）', async ({ request }) => {
    const html = await (await request.get('/')).text();
    const noscript = html.slice(html.indexOf('<noscript>'), html.indexOf('</noscript>'));
    expect(noscript).toContain('2段階認証');
    expect(noscript).toContain('ゼロ知識');
    expect(noscript).toContain('主な特徴');
    expect(noscript).toContain('TOTP');
    expect(noscript).toContain('パスキー');
    expect(noscript).toContain('プライバシー');
  });
});
