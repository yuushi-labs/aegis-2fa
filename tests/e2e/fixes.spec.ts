import { test, expect, createVault, unlock, addManualAccount, PASSWORD, RFC_SECRET } from './helpers';

test.describe('QR / CSV / バックアップの取り扱い', () => {
  test('アカウント詳細から QR を PNG でダウンロードできる', async ({ page }) => {
    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: 'QrCo', label: 'qr@example.com', secret: RFC_SECRET });

    await page.getByTestId('account-row').first().dblclick();
    await expect(page.getByRole('heading', { name: /QrCo/ })).toBeVisible();

    // QR 表示モーダル → PNG ダウンロード（ブラウザ API で生成される）。
    await page.getByRole('button', { name: /QR/ }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('img[alt]')).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'PNG を保存' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.png$/);
    const path = await download.path();
    expect(path).not.toBeNull();
  });

  test('CSV 出力は数式として解釈される先頭文字を無効化する', async ({ page }) => {
    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: '=1+1', label: '@cmd', secret: RFC_SECRET });

    await page.getByRole('link', { name: '設定', exact: true }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /CSV/ }).first().click();
    await page.getByRole('button', { name: 'ダウンロード' }).click();
    const download = await downloadPromise;
    const path = await download.path();
    expect(path).not.toBeNull();
    const content = await download.createReadStream().then(async (stream) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString('utf8');
    });
    // 先頭に ' を付けて数式評価を無効化している。
    expect(content).toContain(`"'=1+1"`);
    expect(content).toContain(`"'@cmd"`);
    expect(content).not.toContain('"=1+1"');
  });

  test('別ボルトのバックアップを「マージ」で取り込める', async ({ page }) => {
    // 1 つ目のボルト（別のパスワード）でバックアップを作る。
    await createVault(page, { sync: false, password: 'another-master-password-99' });
    await addManualAccount(page, { issuer: 'Imported', label: 'old@example.com', secret: RFC_SECRET });
    await page.getByRole('link', { name: '設定', exact: true }).click();
    const backupPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /暗号化バックアップ/ }).click();
    const backup = await backupPromise;
    const backupPath = test.info().outputPath('other-vault.aegis');
    await backup.saveAs(backupPath);

    // 端末を消して、別パスワードの新しいボルトを作る。
    await page.getByRole('button', { name: 'ボルトを削除', exact: true }).click();
    await page.getByRole('button', { name: '削除する' }).click();
    await expect(page.getByRole('heading', { name: 'ボルトをつくる' })).toBeVisible();

    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: 'Current', label: 'new@example.com', secret: 'JBSWY3DPEHPK3PXP' });

    await page.getByRole('link', { name: '設定', exact: true }).click();
    await page.getByTestId('backup-file-input').setInputFiles(backupPath);
    const dialog = page.getByRole('dialog', { name: 'バックアップを読み込む' });
    // バックアップ自身のパスワードを入れる（現在のボルトのパスワードではない）。
    await dialog.getByLabel('マスターパスワード').fill('another-master-password-99');
    await dialog.getByRole('button', { name: 'マージする' }).click();
    await dialog.getByRole('button', { name: '実行する' }).click();

    await expect(page.getByRole('heading', { name: 'アカウント' })).toBeVisible();
    // 現在のアカウントも取り込んだアカウントも残る。
    await expect(page.getByText('Current')).toBeVisible();
    await expect(page.getByText('Imported')).toBeVisible();

    // 現在のボルトのパスワードで解錠し直せる。
    await page.getByRole('button', { name: 'ロック', exact: true }).click();
    await unlock(page, PASSWORD);
    await expect(page.getByText('Imported')).toBeVisible();
  });
});

test.describe('モーダルのフォーカス', () => {
  test('Tab / Shift+Tab でモーダルの外へ抜けない', async ({ page }) => {
    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: 'FocusCo', label: 'focus@example.com', secret: RFC_SECRET });

    await page.getByTestId('account-row').first().dblclick();
    await page.getByRole('button', { name: /削除/ }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Shift+Tab');
    }
    const insideAfterBackwards = await page.evaluate(() => {
      const dialogEl = document.querySelector('[role="dialog"]');
      return dialogEl !== null && dialogEl.contains(document.activeElement);
    });
    expect(insideAfterBackwards).toBe(true);

    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
    }
    const insideAfterForwards = await page.evaluate(() => {
      const dialogEl = document.querySelector('[role="dialog"]');
      return dialogEl !== null && dialogEl.contains(document.activeElement);
    });
    expect(insideAfterForwards).toBe(true);
  });
});

test.describe('同期の基準 revision', () => {
  test('デバウンス内に連続編集しても 409 の偽の競合にならない', async ({ page }) => {
    const isPut = (response: { url: () => string; request: () => { method: () => string } }): boolean =>
      response.url().includes('/api/vault/') && response.request().method() === 'PUT';

    const initial = page.waitForResponse(isPut, { timeout: 20_000 });
    await createVault(page, { sync: true });
    expect((await initial).status()).toBe(200);

    const firstAdd = page.waitForResponse(isPut, { timeout: 20_000 });
    await addManualAccount(page, { issuer: 'One', label: 'one@example.com', secret: RFC_SECRET });
    expect((await firstAdd).status()).toBe(200);

    const secondAdd = page.waitForResponse(isPut, { timeout: 20_000 });
    await addManualAccount(page, { issuer: 'Two', label: 'two@example.com', secret: 'JBSWY3DPEHPK3PXP' });
    expect((await secondAdd).status()).toBe(200);

    // 2 秒のデバウンス窓の中で 2 回編集する（revision が 2 つ進む）。
    const rows = page.getByTestId('account-row');
    const merged = page.waitForResponse(isPut, { timeout: 20_000 });
    await rows.nth(0).getByRole('button', { name: 'ピン留めする' }).click();
    await rows.nth(1).getByRole('button', { name: 'ピン留めする' }).click();

    // 基準 revision がずれていれば 409 → 競合ダイアログが出る。出ないこと。
    const response = await merged;
    expect(response.status()).toBe(200);
    await expect(page.getByRole('dialog', { name: '同期の競合' })).toHaveCount(0);
  });
});

test.describe('削除の同期', () => {
  test('削除したアカウントは別端末とのマージで復活しない', async ({ browser }) => {
    const isPut = (response: { url: () => string; request: () => { method: () => string } }): boolean =>
      response.url().includes('/api/vault/') && response.request().method() === 'PUT';

    const contextA = await browser.newContext({ locale: 'ja-JP' });
    const pageA = await contextA.newPage();
    const initial = pageA.waitForResponse(isPut, { timeout: 20_000 });
    const token = await createVault(pageA, { sync: true });
    await initial;

    const addOne = pageA.waitForResponse(isPut, { timeout: 20_000 });
    await addManualAccount(pageA, { issuer: 'Alpha', label: 'alpha@example.com', secret: RFC_SECRET });
    expect((await addOne).status()).toBe(200);
    const addTwo = pageA.waitForResponse(isPut, { timeout: 20_000 });
    await addManualAccount(pageA, { issuer: 'Beta', label: 'beta@example.com', secret: 'JBSWY3DPEHPK3PXP' });
    expect((await addTwo).status()).toBe(200);

    // 端末 B は同じボルトを読む（Alpha/Beta を保持）。
    const contextB = await browser.newContext({ locale: 'ja-JP' });
    const pageB = await contextB.newPage();
    await pageB.goto('/');
    await expect(pageB.getByRole('heading', { name: 'ボルトをつくる' })).toBeVisible();
    await pageB.getByRole('link', { name: '接続する' }).click();
    await pageB.getByTestId('sync-code-input').fill(token ?? '');
    await pageB.getByTestId('sync-connect').click();
    await expect(pageB.getByRole('heading', { name: 'ロック中' })).toBeVisible();
    await unlock(pageB);
    await expect(pageB.getByTestId('account-row').filter({ hasText: 'Alpha' })).toHaveCount(1);

    // 端末 A で Alpha を削除して同期する。
    const deleted = pageA.waitForResponse(isPut, { timeout: 20_000 });
    await pageA.getByTestId('account-row').filter({ hasText: 'Alpha' }).dblclick();
    await pageA.getByRole('button', { name: /削除/ }).first().click();
    await pageA.getByRole('button', { name: '削除する' }).click();
    expect((await deleted).status()).toBe(200);
    await expect(pageA.getByTestId('account-row').filter({ hasText: 'Alpha' })).toHaveCount(0);

    // 端末 B は古い状態のまま編集 → 409 → マージしても Alpha は戻らない。
    await pageB.getByTestId('account-row').filter({ hasText: 'Beta' }).getByRole('button', { name: 'ピン留めする' }).click();
    const dialog = pageB.getByRole('dialog', { name: '同期の競合' });
    await expect(dialog).toBeVisible({ timeout: 25_000 });
    await dialog.getByRole('button', { name: 'マージする' }).click();
    await expect(dialog).toHaveCount(0, { timeout: 20_000 });
    await expect(pageB.getByTestId('account-row').filter({ hasText: 'Beta' })).toHaveCount(1);
    await expect(pageB.getByTestId('account-row').filter({ hasText: 'Alpha' })).toHaveCount(0);

    await contextA.close();
    await contextB.close();
  });
});
