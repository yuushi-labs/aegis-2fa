import { expect, test } from '@playwright/test';
import { PASSWORD, RFC_SECRET, addManualAccount, createVault } from './helpers';

/**
 * 追加した 6 機能（メモ・ゴミ箱・重複チェック/並べ替え・印刷シート・
 * 複数ボルト・同期端末）の画面からの導線。
 */

test.describe('サービスごとのメモとバックアップコード', () => {
  test('メモとコードを保存し、使用済みの印を付けられる', async ({ page }) => {
    await createVault(page, { sync: false });
    await page.getByRole('link', { name: '追加', exact: true }).click();
    await page.getByLabel('サービス名', { exact: true }).fill('NotesCo');
    await page.getByLabel('アカウント名', { exact: true }).fill('me@example.com');
    await page.getByTestId('secret-input').fill(RFC_SECRET);
    await page.getByTestId('notes-input').fill('予備の鍵は金庫');

    // 改行・カンマ区切りでまとめて追加する。
    await page.getByTestId('add-codes-bulk').fill('AAAA-1111, BBBB-2222\nCCCC-3333');
    await page.getByTestId('add-codes-add').click();
    await expect(page.getByTestId('add-codes-list').locator('li')).toHaveCount(3);
    await expect(page.getByTestId('add-codes-remaining')).toContainText('未使用 3');

    await page.getByTestId('save-account').click();
    await expect(page.getByRole('heading', { name: 'アカウント' })).toBeVisible();

    const row = page.getByTestId('account-row').first();
    await expect(row.getByTestId('row-notes')).toBeVisible();
    await expect(row.getByTestId('row-codes')).toContainText('未使用 3');

    // 詳細画面で 1 件を使用済みにする。
    await row.getByTestId('edit-account').click();
    await expect(page.getByTestId('edit-codes-remaining')).toContainText('未使用 3');
    await page.getByTestId('edit-codes-toggle').first().click();
    await expect(page.getByTestId('edit-codes-remaining')).toContainText('未使用 2');
    await page.getByTestId('save-changes').click();

    await expect(page.getByTestId('account-row').first().getByTestId('row-codes')).toContainText(
      '未使用 2',
    );
    // メモは暗号化ペイロードの中だけにあり、localStorage には平文で残らない。
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    expect(stored).not.toContain('予備の鍵は金庫');
  });
});

test.describe('ゴミ箱（30 日復元）', () => {
  test('削除 → ゴミ箱で復元 → 完全削除までできる', async ({ page }) => {
    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: 'TrashCo', label: 't@example.com', secret: RFC_SECRET });

    await page.getByTestId('account-row').getByTestId('delete-account').click();
    await page.getByTestId('confirm-delete-account').click();
    // 通常の一覧からは消える（ゴミ箱に移っただけ）。
    await expect(page.getByTestId('account-row')).toHaveCount(0);

    await page.getByTestId('trash-link').click();
    await expect(page.getByRole('heading', { name: 'ゴミ箱' })).toBeVisible();
    await expect(page.getByTestId('trash-row')).toHaveCount(1);
    await expect(page.getByTestId('trash-row')).toContainText('TrashCo');
    await expect(page.getByTestId('trash-row')).toContainText('あと 30 日で完全削除');

    await page.getByTestId('trash-restore').click();
    await expect(page.getByTestId('trash-empty-state')).toBeVisible();

    await page.getByRole('link', { name: /一覧へ戻る/ }).click();
    await expect(page.getByTestId('account-row')).toHaveCount(1);

    // もう一度ゴミ箱へ入れ、今度は完全に削除する。
    await page.getByTestId('delete-account').click();
    await page.getByTestId('confirm-delete-account').click();
    await page.getByTestId('trash-link').click();
    await page.getByTestId('trash-purge').click();
    await page.getByTestId('trash-purge-confirm').click();
    await expect(page.getByTestId('trash-empty-state')).toBeVisible();
    await expect(page.getByTestId('trash-row')).toHaveCount(0);
  });
});

test.describe('重複チェック', () => {
  test('同じ秘密鍵は警告し、確認すると追加できる', async ({ page }) => {
    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: 'DupCo', label: 'a@example.com', secret: RFC_SECRET });

    await page.getByRole('link', { name: '追加', exact: true }).click();
    await page.getByLabel('サービス名', { exact: true }).fill('Another');
    await page.getByLabel('アカウント名', { exact: true }).fill('b@example.com');
    await page.getByTestId('secret-input').fill(RFC_SECRET);
    await page.getByTestId('save-account').click();

    const dialog = page.getByRole('dialog', { name: '重複している可能性があります' });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('duplicate-list')).toContainText('DupCo');
    await expect(page.getByTestId('duplicate-list')).toContainText('同じ秘密鍵');

    // やめると追加画面に残る。
    await dialog.getByRole('button', { name: 'やめる' }).click();
    await expect(page.getByRole('heading', { name: 'アカウントを追加' })).toBeVisible();
    await expect(page.getByTestId('account-row')).toHaveCount(0);

    // 確認の上で追加する。
    await page.getByTestId('save-account').click();
    await page.getByTestId('duplicate-continue').click();
    await expect(page.getByTestId('account-row')).toHaveCount(2);
  });
});

test.describe('並べ替え', () => {
  test('名前順・よく使う順に切り替えられ、選択が残る', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: 'Zebra', label: 'z@example.com', secret: RFC_SECRET });
    await addManualAccount(page, {
      issuer: 'Apple',
      label: 'a@example.com',
      secret: 'JBSWY3DPEHPK3PXP',
    });

    // 手動順では追加順。
    await expect(page.getByTestId('account-row').first()).toContainText('Zebra');

    await page.getByTestId('sort-name').click();
    await expect(page.getByTestId('account-row').first()).toContainText('Apple');

    await page.getByTestId('sort-manual').click();
    await expect(page.getByTestId('account-row').first()).toContainText('Zebra');

    // Apple のコードをコピーすると「よく使う順」で先頭に来る。
    await page.getByTestId('sort-usage').click();
    await page
      .getByTestId('account-row')
      .filter({ hasText: 'Apple' })
      .getByRole('button', { name: /コードをコピー/ })
      .click();
    await expect(page.getByTestId('account-row').first()).toContainText('Apple');

    // 選んだ並び順は設定として残る（画面を移動しても保たれる）。
    await page.getByRole('link', { name: '設定', exact: true }).click();
    await page.getByRole('link', { name: 'Aegis' }).click();
    await expect(page.getByTestId('sort-usage')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('account-row').first()).toContainText('Apple');
  });
});

test.describe('緊急バックアップ印刷シート', () => {
  test('警告を確認してから、秘密鍵と QR を載せたシートを開ける', async ({ page }) => {
    await createVault(page, { sync: false });
    await addManualAccount(page, {
      issuer: 'PrintCo',
      label: 'p@example.com',
      secret: RFC_SECRET,
    });

    await page.getByRole('link', { name: '設定', exact: true }).click();
    await page.getByTestId('open-print-sheet').click();
    const dialog = page.getByRole('dialog', { name: '緊急バックアップ印刷シート' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('平文の秘密鍵');
    await page.getByTestId('confirm-print-sheet').click();

    await expect(page).toHaveURL(/\/print$/);
    await expect(page.getByRole('heading', { name: '緊急バックアップシート' })).toBeVisible();
    const card = page.getByTestId('print-account');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('PrintCo');
    await expect(card).toContainText(RFC_SECRET);
    await expect(card.getByRole('img')).toBeVisible();
    // 印刷ボタンは操作系なので印刷時には出さない。
    await expect(page.getByTestId('print-button')).toBeVisible();
  });
});

test.describe('複数ボルト（プロファイル）', () => {
  test('2 つ目のボルトを作り、切り替えても中身とパスワードが混ざらない', async ({ page }) => {
    const secondPassword = 'second-vault-passphrase-77';
    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: 'MainCo', label: 'main@example.com', secret: RFC_SECRET });

    await page.getByRole('link', { name: '設定', exact: true }).click();
    await page.getByTestId('new-profile-name').fill('仕事用');
    await page.getByTestId('profile-create').click();

    // 新しいボルトはまだ空なので、作成画面から始まる。
    await expect(page.getByRole('heading', { name: 'ボルトをつくる' })).toBeVisible();
    await page.getByLabel('マスターパスワード', { exact: true }).fill(secondPassword);
    await page.getByLabel('マスターパスワード（確認）').fill(secondPassword);
    await page.getByRole('radio', { name: /この端末だけで使う/ }).check();
    await page.getByRole('button', { name: 'ボルトを作成' }).click();
    await expect(page.getByRole('heading', { name: 'アカウント' })).toBeVisible();
    await expect(page.getByTestId('account-row')).toHaveCount(0);

    // ヘッダーからメインへ戻すと、メインのボルトはロックされている。
    await page.getByTestId('profile-switch').selectOption({ label: 'メイン' });
    await expect(page.getByRole('heading', { name: 'ロック中' })).toBeVisible();
    // 2 つ目のパスワードでは開かない。
    await page.getByLabel('マスターパスワード', { exact: true }).fill(secondPassword);
    await page.getByRole('button', { name: '解錠する' }).click();
    await expect(page.getByRole('heading', { name: 'ロック中' })).toBeVisible();
    await page.getByLabel('マスターパスワード', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '解錠する' }).click();
    await page.getByRole('link', { name: 'Aegis' }).click();
    await expect(page.getByTestId('account-row')).toHaveCount(1);
    await expect(page.getByTestId('account-row')).toContainText('MainCo');
  });
});

test.describe('同期されたデバイス', () => {
  test('自端末が一覧に出て、名前を変えられる', async ({ page }) => {
    await createVault(page, { sync: true });
    await page.getByRole('link', { name: '設定', exact: true }).click();
    await expect(page.getByTestId('device-list')).toBeVisible();
    await expect(page.getByTestId('device-self')).toBeVisible();

    await page.getByTestId('device-rename').first().click();
    await page.getByTestId('device-rename-input').fill('My phone');
    await page.getByTestId('device-rename-save').click();
    await expect(page.getByTestId('device-list')).toContainText('My phone');

    // 名前は端末（localStorage）に残り、再読み込み後も同じ。
    await page.reload();
    await page.getByLabel('マスターパスワード', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '解錠する' }).click();
    await page.getByRole('link', { name: '設定', exact: true }).click();
    await expect(page.getByTestId('device-list')).toContainText('My phone');
  });
});
