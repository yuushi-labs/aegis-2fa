import { test as base, expect, type Page } from '@playwright/test';

export const PASSWORD = 'correct-horse-battery-staple-42';
/** RFC 6238 のテスト鍵（ASCII "12345678901234567890"）の Base32。 */
export const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

/**
 * 時刻を固定したままアプリを起動する（TOTP の一致検証用）。
 * page.clock は Date.now() / new Date() を固定しつつ、タイマーは実時間で進める。
 * page.goto より前に呼ぶこと。
 */
export async function installFixedClock(page: Page, unixSeconds: number): Promise<void> {
  await page.clock.setFixedTime(unixSeconds * 1000);
}

export async function createVault(page: Page, options: { sync: boolean; password?: string }): Promise<string | null> {
  const password = options.password ?? PASSWORD;
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ボルトをつくる' })).toBeVisible();
  await page.getByLabel('マスターパスワード', { exact: true }).fill(password);
  await page.getByLabel('マスターパスワード（確認）').fill(password);
  const syncRadio = options.sync ? page.getByRole('radio', { name: /同期する/ }) : page.getByRole('radio', { name: /この端末だけで使う/ });
  await syncRadio.check();
  await page.getByRole('button', { name: 'ボルトを作成' }).click();
  if (!options.sync) {
    await expect(page.getByRole('heading', { name: 'アカウント' })).toBeVisible();
    return null;
  }
  const code = page.getByTestId('sync-code');
  await expect(code).toBeVisible();
  const token = (await code.textContent())?.replace(/\s+/g, '') ?? null;
  await page.getByRole('button', { name: '保管しました' }).click();
  await expect(page.getByRole('heading', { name: 'アカウント' })).toBeVisible();
  return token;
}

export async function unlock(page: Page, password = PASSWORD): Promise<void> {
  await expect(page.getByRole('heading', { name: 'ロック中' })).toBeVisible();
  await page.getByLabel('マスターパスワード', { exact: true }).fill(password);
  await page.getByRole('button', { name: '解錠する' }).click();
  // 解錠後は直前の URL に戻るので、一覧へはヘッダーのリンクで SPA 遷移する
  // （goto すると DEK がメモリから消えて再ロックされる）。
  await expect(page.getByRole('button', { name: 'ロック', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Aegis' }).click();
  await expect(page.getByRole('heading', { name: 'アカウント' })).toBeVisible();
}

export async function addManualAccount(
  page: Page,
  account: { issuer: string; label: string; secret: string },
): Promise<void> {
  await page.getByRole('link', { name: '追加', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'アカウントを追加' })).toBeVisible();
  await page.getByLabel('サービス名', { exact: true }).fill(account.issuer);
  await page.getByLabel('アカウント名', { exact: true }).fill(account.label);
  await page.getByTestId('secret-input').fill(account.secret);
  await page.getByTestId('save-account').click();
  await expect(page.getByRole('heading', { name: 'アカウント' })).toBeVisible();
}

export const test = base;
export { expect };
