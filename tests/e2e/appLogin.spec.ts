import { test, expect, createVault } from './helpers';

test.describe('アプリでログイン（Android アプリへの引き渡し）', () => {
  test('同期していないボルトでも、押すと同期コードを自動発行して初回同期し、案内を出す', async ({ page }) => {
    await createVault(page, { sync: false });
    await page.getByRole('link', { name: '設定' }).click();

    const section = page.getByTestId('app-login-section');
    await expect(section).toBeVisible();
    await expect(section.getByRole('button', { name: '📱 アプリでログイン' })).toBeVisible();
    // 押す前は同期していない。
    await expect(page.getByText('この端末のみ（同期なし）')).toBeVisible();

    await page.getByTestId('app-login').click();

    await expect(page.getByTestId('app-login-notice')).toContainText('Aegis Android アプリを開いています');
    await expect(page.getByTestId('app-login-notice')).toContainText('GitHub Releases');
    // 同期コードが発行され、サーバーへ初回同期まで終わっている。
    await expect(page.getByTestId('sync-status')).toHaveText('同期済み');
    await expect(page.getByTestId('sync-code-value')).toBeVisible();

    // 発行されたコードは、そのまま QR・コピーでも使える形で出ている。
    await page.getByTestId('sync-qr-open').click();
    const code = page.getByTestId('sync-qr-image');
    await expect(code).toBeVisible();
  });

  test('同期済みのボルトでは既存の同期コードを変えずに案内を出す', async ({ page }) => {
    const token = await createVault(page, { sync: true });
    await page.getByRole('link', { name: '設定' }).click();
    await expect(page.getByTestId('sync-status')).toHaveText('同期済み');

    await page.getByTestId('app-login').click();
    await expect(page.getByTestId('app-login-notice')).toContainText('Aegis Android アプリを開いています');

    // 同期コードは作り直さない（表示して、操作前のコードと一致することを確かめる）。
    await page.getByRole('button', { name: '表示する' }).click();
    const shown = (await page.getByTestId('sync-code-value').textContent())?.replace(/\s+/g, '') ?? '';
    expect(shown).toBe(token);
  });

  test('同期画面にも同じボタンがあり、押すと案内が出る', async ({ page }) => {
    await createVault(page, { sync: false });
    await page.getByRole('link', { name: '設定' }).click();
    await page.getByRole('button', { name: '接続する' }).click();
    await expect(page.getByTestId('app-login-card')).toBeVisible();

    await page.getByTestId('app-login-card').getByTestId('app-login').click();
    await expect(page.getByTestId('app-login-notice')).toContainText('Aegis Android アプリを開いています');
  });
});
