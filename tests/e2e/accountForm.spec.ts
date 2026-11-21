import { test, expect, addManualAccount, createVault, RFC_SECRET } from './helpers';

/** 手入力フォームの秘密鍵欄に貼っても分解しないことの確認用（8 桁・SHA-256・60 秒）。 */
const URI =
  `otpauth://totp/GitHub:octocat%40example.com?secret=${RFC_SECRET}` +
  '&issuer=GitHub&algorithm=SHA256&digits=8&period=60';

test.describe('アカウント追加画面', () => {
  test('追加手段は「手入力」「QR 読み取り」「画像から」「一括移行」だけで、URI の手入力欄は無い', async ({ page }) => {
    await createVault(page, { sync: false });
    await page.getByRole('link', { name: '追加', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'アカウントを追加' })).toBeVisible();

    for (const name of ['手入力', 'QR 読み取り', '画像から', '一括移行']) {
      await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('tab')).toHaveCount(4);
    // otpauth:// URI の入力欄と「URI を読み取る」ボタンは廃止した。
    await expect(page.getByLabel('otpauth:// URI')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'URI を読み取る' })).toHaveCount(0);
    await expect(page.getByPlaceholder('otpauth://totp/...')).toHaveCount(0);
  });

  test('秘密鍵欄に otpauth URI を貼っても分解せず、Base32 エラーになる', async ({ page }) => {
    await createVault(page, { sync: false });
    await page.getByRole('link', { name: '追加', exact: true }).click();

    await page.getByTestId('secret-input').fill(URI);

    await expect(page.getByRole('alert')).toContainText('秘密鍵が Base32 として正しくありません');
    await expect(page.getByLabel('サービス名', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('アカウント名', { exact: true })).toHaveValue('');
    // 欄の中身は貼った文字列のまま（勝手に書き換えない）。
    await expect(page.getByTestId('secret-input')).toHaveValue(URI);
    await expect(page.getByTestId('save-account')).toBeDisabled();
  });
});

test.describe('サービス名のクイック候補', () => {
  test('候補を押すとサービス名が入り、選択状態になる', async ({ page }) => {
    await createVault(page, { sync: false });
    await page.getByRole('link', { name: '追加', exact: true }).click();

    const suggestions = page.getByTestId('add-issuer-suggestions');
    await expect(suggestions).toBeVisible();
    await suggestions.getByRole('button', { name: 'Discord' }).click();
    await expect(page.getByLabel('サービス名', { exact: true })).toHaveValue('Discord');
    await expect(suggestions.getByRole('button', { name: 'Discord' })).toHaveAttribute('aria-pressed', 'true');

    // 手入力した名前が候補に一致すれば選択状態になる（大小文字は無視）。
    await page.getByLabel('サービス名', { exact: true }).fill('github');
    await expect(suggestions.getByRole('button', { name: 'GitHub' })).toHaveAttribute('aria-pressed', 'true');
    await expect(suggestions.getByRole('button', { name: 'Discord' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('編集画面でも候補からサービス名を変えられる', async ({ page }) => {
    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: 'Example', label: 'me@example.com', secret: RFC_SECRET });

    await page.getByTestId('account-row').filter({ hasText: 'Example' }).dblclick();
    await expect(page.getByRole('heading', { name: 'Example' })).toBeVisible();
    await page.getByTestId('edit-issuer-suggestions').getByRole('button', { name: 'Notion' }).click();
    await expect(page.getByLabel('サービス名', { exact: true })).toHaveValue('Notion');
  });
});
