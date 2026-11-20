import type { Page } from '@playwright/test';
import { test, expect, createVault, addManualAccount, RFC_SECRET } from './helpers';

/** 画面全体が横にはみ出していないか（1px の丸め誤差は許す）。 */
async function overflowPx(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe('スマホ幅（360px / 390px）のレイアウト', () => {
  test('主要な画面がどれも横にはみ出さない', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await createVault(page, { sync: false });
    await addManualAccount(page, {
      issuer: 'とても長いサービス名のテスト株式会社',
      label: 'a-very-long-account-name@example.com',
      secret: RFC_SECRET,
    });
    expect(await overflowPx(page)).toBeLessThanOrEqual(1);

    // 追加（タブ・URI 欄・フォーム）
    await page.getByRole('link', { name: '追加', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'アカウントを追加' })).toBeVisible();
    expect(await overflowPx(page)).toBeLessThanOrEqual(1);
    await page.getByTestId('tab-qr').click();
    expect(await overflowPx(page)).toBeLessThanOrEqual(1);
    await page.getByTestId('tab-migration').click();
    expect(await overflowPx(page)).toBeLessThanOrEqual(1);
    await page.getByRole('link', { name: 'Aegis' }).click();

    // 詳細（コード表示・削除ボタン）
    await page.getByTestId('account-row').first().getByTestId('edit-account').click();
    await expect(page.getByTestId('delete-account-detail')).toBeVisible();
    const deleteBox = await page.getByTestId('delete-account-detail').boundingBox();
    expect(deleteBox).not.toBeNull();
    expect((deleteBox?.x ?? 0) + (deleteBox?.width ?? 0)).toBeLessThanOrEqual(361);
    expect(deleteBox?.height ?? 0).toBeGreaterThanOrEqual(36);
    expect(await overflowPx(page)).toBeLessThanOrEqual(1);

    // 設定
    await page.getByRole('link', { name: '設定', exact: true }).click();
    expect(await overflowPx(page)).toBeLessThanOrEqual(1);

    // 同期（QR パネルを開いた状態）
    await page.getByRole('button', { name: '接続する' }).click();
    await expect(page.getByRole('heading', { name: '同期コードを入力' })).toBeVisible();
    expect(await overflowPx(page)).toBeLessThanOrEqual(1);
    await page.getByTestId('sync-scan-toggle').click();
    expect(await overflowPx(page)).toBeLessThanOrEqual(1);

    // 390px でも同じ。
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await overflowPx(page)).toBeLessThanOrEqual(1);
  });

  test('行の操作ボタンが 1 タップで押せる大きさで画面内にある', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await createVault(page, { sync: false });
    await addManualAccount(page, {
      issuer: 'とても長いサービス名のテスト株式会社',
      label: 'long-name@example.com',
      secret: RFC_SECRET,
    });

    const row = page.getByTestId('account-row').first();
    for (const button of await row.getByRole('button').all()) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      if (box === null) continue;
      expect(box.width).toBeGreaterThanOrEqual(24);
      expect(box.height).toBeGreaterThanOrEqual(24);
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(361);
    }

    // 削除・編集は文字ラベル付きで見えている。
    await expect(row.getByTestId('delete-account')).toBeVisible();
    await expect(row.getByTestId('edit-account')).toBeVisible();
  });

  test('360px で行の削除まで 1 タップで到達できる', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: 'SmallPhone', label: 'small@example.com', secret: RFC_SECRET });
    await page.getByTestId('account-row').first().getByTestId('delete-account').click();
    await page.getByTestId('confirm-delete-account').click();
    await expect(page.getByTestId('account-row')).toHaveCount(0);
  });
});

test.describe('スマホ幅のオンボーディングとロック画面', () => {
  test('360px でも初回設定とロック画面がはみ出さない', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'ボルトをつくる' })).toBeVisible();
    expect(await overflowPx(page)).toBeLessThanOrEqual(1);

    await createVault(page, { sync: false });
    await page.getByRole('button', { name: 'ロック', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'ロック中' })).toBeVisible();
    expect(await overflowPx(page)).toBeLessThanOrEqual(1);
  });
});
