import { test, expect, createVault, addManualAccount, RFC_SECRET } from './helpers';
import { encodeMigrationPayload } from '../../shared/migration';

/** 手入力フォームの秘密鍵欄に貼る URI（8 桁・SHA-256・60 秒）。 */
const URI =
  `otpauth://totp/GitHub:octocat%40example.com?secret=${RFC_SECRET}` +
  '&issuer=GitHub&algorithm=SHA256&digits=8&period=60';

test.describe('秘密鍵欄への otpauth URI 貼り付け', () => {
  test('URI を貼るとフォーム全体に展開され、トーストが出る', async ({ page }) => {
    await createVault(page, { sync: false });
    await page.getByRole('link', { name: '追加', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'アカウントを追加' })).toBeVisible();

    await page.getByTestId('secret-input').fill(URI);

    await expect(page.getByLabel('サービス名', { exact: true })).toHaveValue('GitHub');
    await expect(page.getByLabel('アカウント名', { exact: true })).toHaveValue('octocat@example.com');
    await expect(page.getByTestId('secret-input')).toHaveValue(RFC_SECRET);
    await expect(page.getByText('貼り付けた URI からフォームに入れました')).toBeVisible();

    // 詳細設定（アルゴリズム・桁数・周期）も URI の値になる。
    await page.getByRole('button', { name: /詳細設定/ }).click();
    await expect(page.getByLabel('アルゴリズム')).toHaveValue('SHA256');
    await expect(page.getByLabel('桁数')).toHaveValue('8');
    await expect(page.getByLabel('更新間隔（秒）')).toHaveValue('60');

    // そのまま保存でき、一覧に反映される。
    await page.getByTestId('save-account').click();
    await expect(page.getByRole('heading', { name: 'アカウント' })).toBeVisible();
    await expect(page.getByTestId('account-row').filter({ hasText: 'GitHub' })).toHaveCount(1);
  });

  test('移行 URI は一括移行タブへ切り替わる', async ({ page }) => {
    const migrationUri = encodeMigrationPayload([
      {
        secret: RFC_SECRET,
        name: 'alice@example.com',
        issuer: 'Migrated',
        algorithm: 'SHA1',
        digits: 6,
        type: 'totp',
        counter: 0,
      },
    ]);

    await createVault(page, { sync: false });
    await page.getByRole('link', { name: '追加', exact: true }).click();
    await page.getByTestId('secret-input').fill(migrationUri);

    await expect(page.getByTestId('tab-migration')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('migration-input')).toHaveValue(migrationUri);
    await expect(page.getByText('1 件のアカウントが見つかりました')).toBeVisible();
    // 秘密鍵欄は URI で汚さない（手入力タブに戻っても空のまま）。
    await page.getByTestId('tab-manual').click();
    await expect(page.getByTestId('secret-input')).toHaveValue('');
  });

  test('壊れた otpauth URI は秘密鍵として扱い、Base32 エラーを出す', async ({ page }) => {
    await createVault(page, { sync: false });
    await page.getByRole('link', { name: '追加', exact: true }).click();
    await page.getByTestId('secret-input').fill('otpauth://totp/a?issuer=x');

    await expect(page.getByRole('alert')).toContainText('秘密鍵が Base32 として正しくありません');
    await expect(page.getByLabel('サービス名', { exact: true })).toHaveValue('');
    await expect(page.getByTestId('save-account')).toBeDisabled();
  });
});

test.describe('編集画面での URI 貼り付け', () => {
  test('確認してから入力中の項目を上書きする', async ({ page }) => {
    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: 'Example', label: 'me@example.com', secret: RFC_SECRET });

    await page.getByTestId('account-row').filter({ hasText: 'Example' }).dblclick();
    await expect(page.getByRole('heading', { name: 'アカウントを編集' })).toBeVisible();

    // まずはキャンセル: 入力中の値はそのまま。
    page.once('dialog', (dialog) => void dialog.dismiss());
    await page.getByTestId('secret-input').fill(URI);
    await expect(page.getByLabel('サービス名', { exact: true })).toHaveValue('Example');
    await expect(page.getByLabel('アカウント名', { exact: true })).toHaveValue('me@example.com');
    await expect(page.getByTestId('secret-input')).toHaveValue(RFC_SECRET);

    // 承諾: URI の内容で上書きされ、保存できる。
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByTestId('secret-input').fill(URI);
    await expect(page.getByLabel('サービス名', { exact: true })).toHaveValue('GitHub');
    await expect(page.getByLabel('アカウント名', { exact: true })).toHaveValue('octocat@example.com');
    await expect(page.getByLabel('桁数')).toHaveValue('8');

    await page.getByTestId('save-changes').click();
    await expect(page.getByRole('heading', { name: 'アカウント' })).toBeVisible();
    await expect(page.getByTestId('account-row').filter({ hasText: 'GitHub' })).toHaveCount(1);
  });
});
