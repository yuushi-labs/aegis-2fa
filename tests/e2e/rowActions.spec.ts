import { test, expect, createVault, addManualAccount, RFC_SECRET } from './helpers';

test.describe('アカウント行の操作（削除導線）', () => {
  test('一覧の行から削除できる（確認ダイアログ付き）', async ({ page }) => {
    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: 'RowDelete', label: 'row@example.com', secret: RFC_SECRET });

    const row = page.getByTestId('account-row').first();
    await row.getByTestId('delete-account').click();
    const dialog = page.getByRole('dialog', { name: 'アカウントを削除' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'キャンセル' }).click();
    await expect(page.getByTestId('account-row')).toHaveCount(1);

    await row.getByTestId('delete-account').click();
    await page.getByTestId('confirm-delete-account').click();
    await expect(page.getByTestId('account-row')).toHaveCount(0);
    await expect(page.getByText('アカウントを削除しました')).toBeVisible();
  });

  test('行の「詳細・編集」で編集画面に移動できる（ダブルクリック不要）', async ({ page }) => {
    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: 'RowEdit', label: 'edit@example.com', secret: RFC_SECRET });
    await page.getByTestId('account-row').first().getByTestId('edit-account').click();
    await expect(page.getByRole('heading', { name: 'RowEdit' })).toBeVisible();
    await expect(page.getByTestId('delete-account-detail')).toBeVisible();
  });
});
