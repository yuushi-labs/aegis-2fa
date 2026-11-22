import { test, expect, createVault, unlock, addManualAccount, PASSWORD, RFC_SECRET } from './helpers';

test.describe('自動ロック「なし」のセッション継続', () => {
  test('なし ならリロードしても解錠が続き、手動ロックで戻る', async ({ page }) => {
    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: 'SessionCo', label: 'session@example.com', secret: RFC_SECRET });

    await page.getByRole('link', { name: '設定', exact: true }).click();
    await page.getByTestId('auto-lock-select').selectOption('0');
    // なし の説明が出る。
    await expect(page.getByText('このタブを開いている間はパスワード入力なしで復帰します')).toBeVisible();

    await page.reload();
    // 設定画面のまま、ロック画面に戻らない。
    await expect(page.getByRole('heading', { name: '設定' })).toBeVisible();
    await page.getByRole('link', { name: 'Zekey' }).click();
    await expect(page.getByRole('heading', { name: 'アカウント' })).toBeVisible();
    await expect(page.getByTestId('otp-code').first()).toBeVisible();

    // マスターパスワードは保存していない（DEK と封筒の指紋だけ）。
    const stored = await page.evaluate(() => JSON.stringify(window.sessionStorage));
    expect(stored).not.toContain(PASSWORD);

    // 手動ロックは即座に継続を打ち切る。
    await page.getByRole('button', { name: 'ロック', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'ロック中' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'ロック中' })).toBeVisible();

    // 解錠し直して「5 分」に戻すと、次のリロードではロックされる。
    await unlock(page);
    await page.getByRole('link', { name: '設定', exact: true }).click();
    await page.getByTestId('auto-lock-select').selectOption('5');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'ロック中' })).toBeVisible();
  });

  test('既定（5 分）ではこれまでどおりリロードでロックされる', async ({ page }) => {
    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: 'DefaultCo', label: 'default@example.com', secret: RFC_SECRET });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'ロック中' })).toBeVisible();
  });

  test('なし でもロック画面から解錠し直せる／ボルトを消すと継続も消える', async ({ page }) => {
    await createVault(page, { sync: false });
    await page.getByRole('link', { name: '設定', exact: true }).click();
    await page.getByTestId('auto-lock-select').selectOption('0');
    await page.getByRole('link', { name: 'Zekey' }).click();
    await page.getByRole('button', { name: 'ロック', exact: true }).click();
    await unlock(page);

    // ボルトを消したら、リロードしてもロック画面には戻らず初期化画面になる。
    await page.getByRole('link', { name: '設定', exact: true }).click();
    await page.getByRole('button', { name: 'ボルトを削除', exact: true }).click();
    await page.getByRole('button', { name: '削除する' }).click();
    await expect(page.getByRole('heading', { name: 'ボルトをつくる' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'ボルトをつくる' })).toBeVisible();
  });
});
