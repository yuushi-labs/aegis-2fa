import { writeFile } from 'node:fs/promises';
import QRCode from 'qrcode';
import { test, expect, createVault, unlock, addManualAccount, RFC_SECRET } from './helpers';

const CONTEXT = { locale: 'ja-JP', timezoneId: 'Asia/Tokyo' };

test.describe('同期コードの QR 読み取り', () => {
  test('設定画面の同期 QR 画像から読み取り、別の端末として接続できる', async ({ browser }) => {
    const contextA = await browser.newContext(CONTEXT);
    const pageA = await contextA.newPage();
    const token = await createVault(pageA, { sync: true });
    expect(token).not.toBeNull();
    await addManualAccount(pageA, { issuer: 'SyncCo', label: 'sync@example.com', secret: RFC_SECRET });

    // デバウンス 2 秒 + 送信の完了を待ってから QR を読ませる。
    await pageA.getByRole('link', { name: '設定', exact: true }).click();
    await expect(pageA.getByTestId('sync-status')).toHaveText('同期済み', { timeout: 20_000 });
    await pageA.getByTestId('sync-qr-open').click();
    const image = pageA.getByTestId('sync-qr-image');
    await expect(image).toBeVisible();
    const src = (await image.getAttribute('src')) ?? '';
    expect(src.startsWith('data:image/png;base64,')).toBe(true);
    const file = test.info().outputPath('sync-qr.png');
    await writeFile(file, Buffer.from(src.split(',')[1] ?? '', 'base64'));

    // 2 台目（ボルトが無い端末）。
    const contextB = await browser.newContext(CONTEXT);
    const pageB = await contextB.newPage();
    await pageB.goto('/sync');
    await expect(pageB.getByRole('heading', { name: '同期コードを入力' })).toBeVisible();
    await pageB.getByTestId('sync-scan-toggle').click();
    await pageB.getByTestId('sync-qr-image-input').setInputFiles(file);

    // 読み取ったコードが入力欄に入り、ボルトが無い端末なのでそのまま接続する。
    await expect(pageB.getByTestId('sync-code-input')).toHaveValue(token ?? '');
    await expect(pageB.getByRole('heading', { name: 'ロック中' })).toBeVisible();

    await unlock(pageB);
    await expect(pageB.getByText('SyncCo')).toBeVisible();
    await contextA.close();
    await contextB.close();
  });

  test('同期 URL（?sync=）の QR でもコードを抽出してつながる', async ({ browser }) => {
    const contextA = await browser.newContext(CONTEXT);
    const pageA = await contextA.newPage();
    const token = await createVault(pageA, { sync: true });
    expect(token).not.toBeNull();

    // アプリが作る形式（?code=）ではなく、?sync= の URL を QR にして読ませる。
    const png = await QRCode.toBuffer(`https://example.com/zekey/sync?sync=${token}`, { width: 320, margin: 2 });
    const file = test.info().outputPath('sync-url-qr.png');
    await writeFile(file, png);

    // ボルトの無い端末は、読み取った時点で接続まで進んで画面が変わる。
    // ここでは「?sync= からコードを取り出せること」を見たいので、ボルトのある端末で読み取る。
    const contextB = await browser.newContext(CONTEXT);
    const pageB = await contextB.newPage();
    await createVault(pageB, { sync: false });
    await pageB.goto('/sync');
    await pageB.getByTestId('sync-scan-toggle').click();
    await pageB.getByTestId('sync-qr-image-input').setInputFiles(file);
    await expect(pageB.getByTestId('sync-code-input')).toHaveValue(token ?? '');
    await contextA.close();
    await contextB.close();
  });

  test('同期コードを含まない QR は、入力欄を変えずにエラーを出す', async ({ browser }) => {
    const png = await QRCode.toBuffer('https://example.com/not-a-sync-code', { width: 320, margin: 2 });
    const file = test.info().outputPath('invalid-qr.png');
    await writeFile(file, png);

    const context = await browser.newContext(CONTEXT);
    const page = await context.newPage();
    await page.goto('/sync');
    await page.getByTestId('sync-scan-toggle').click();
    await page.getByTestId('sync-qr-image-input').setInputFiles(file);
    await expect(page.getByText('この QR からは同期コードを読み取れませんでした')).toBeVisible();
    await expect(page.getByTestId('sync-code-input')).toHaveValue('');
    await context.close();
  });

  test('入力欄に同期 URL を貼ると同期コードだけになる', async ({ page }) => {
    const token = 'A'.repeat(43);
    await page.goto('/sync');
    await page.getByTestId('sync-code-input').fill(`https://example.com/zekey/sync?code=${token}`);
    await expect(page.getByTestId('sync-code-input')).toHaveValue(token);
  });
});
