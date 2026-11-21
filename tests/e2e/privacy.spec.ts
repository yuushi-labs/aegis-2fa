import type { Page } from '@playwright/test';
import { test, expect, createVault, unlock, PASSWORD } from './helpers';

/**
 * プライバシーポリシー（/privacy）の E2E。
 *
 * ポイントは「ボルトの状態に関係なく読める」こと。未作成（SetupPage の分岐）・
 * ロック中（LockPage の分岐）・解錠中（メインの分岐）のどこからでも、
 * 直リンク（リロード含む）で同じ本文が出ること。
 */
const CONTEXT = { locale: 'ja-JP', timezoneId: 'Asia/Tokyo' };
const PORT = process.env.E2E_PORT ?? '4173';
const ORIGIN = process.env.E2E_ORIGIN ?? `http://localhost:${PORT}`;

async function expectPrivacyPage(page: Page): Promise<void> {
  await expect(page.getByTestId('privacy-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'プライバシーポリシー' })).toBeVisible();
}

test.describe('プライバシーポリシー', () => {
  test('ボルトを作る前でも /privacy を直接開けて、日本語・英語の本文が読める', async ({ page }) => {
    await page.goto('/privacy');
    await expectPrivacyPage(page);
    // ゼロ知識であること、サーバーに置くものが暗号文だけであることが本文にある。
    await expect(page.getByText('ゼロ知識', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('暗号文', { exact: false }).first()).toBeVisible();
    // 最終更新日が入っている。
    await expect(page.getByText(/最終更新: \d{4}-\d{2}-\d{2}/)).toBeVisible();

    // 英語版も同じ URL で読める（公開文書は UI の言語設定に縛られない）。
    await page.getByTestId('privacy-language-en').click();
    await expect(page.getByRole('heading', { name: 'Privacy policy' })).toBeVisible();
    await expect(page.getByText('zero-knowledge', { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/Last updated: \d{4}-\d{2}-\d{2}/)).toBeVisible();
    // 見出しと日付も本文の言語に合わせる（UI の言語設定とは独立）。
    await page.getByTestId('privacy-language-ja').click();
    await expect(page.getByRole('heading', { name: 'プライバシーポリシー' })).toBeVisible();

    // 戻るとボルト作成の画面（まだボルトが無い）。
    await page.getByTestId('privacy-back').click();
    await expect(page.getByRole('heading', { name: 'ボルトをつくる' })).toBeVisible();
  });

  test('ロック中でも解錠せずに開けて、戻るとロック画面に戻る（リロードも可）', async ({ page }) => {
    await createVault(page, { sync: false });
    await page.getByRole('button', { name: 'ロック', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'ロック中' })).toBeVisible();

    await page.getByTestId('privacy-link').first().click();
    await expectPrivacyPage(page);
    // 解錠用の入力欄は出ない（ポリシーだけを読むページ）。
    await expect(page.getByLabel('マスターパスワード', { exact: true })).toHaveCount(0);

    await page.getByTestId('privacy-back').click();
    await expect(page.getByRole('heading', { name: 'ロック中' })).toBeVisible();

    // 直リンクとリロードでも同じ本文が出る（SPA のフォールバックが効いている前提）。
    await page.goto('/privacy');
    await expectPrivacyPage(page);
    await page.reload();
    await expectPrivacyPage(page);
  });

  test('解錠中はフッターと設定の「このアプリについて」から開ける', async ({ page }) => {
    await createVault(page, { sync: false });

    // フッターのリンク。
    await page.getByTestId('privacy-link').last().click();
    await expectPrivacyPage(page);
    await page.getByTestId('privacy-back').click();
    await expect(page.getByRole('heading', { name: 'アカウント' })).toBeVisible();

    // 設定の「このアプリについて」。
    await page.getByRole('link', { name: '設定', exact: true }).click();
    await page.getByRole('link', { name: 'プライバシーポリシー' }).click();
    await expectPrivacyPage(page);
    await page.getByTestId('privacy-back').click();
    await expect(page.getByRole('heading', { name: '設定' })).toBeVisible();
  });

  test('パスキーの欄は、この端末の登録とほかの端末の登録を分けて表示する', async ({ browser }) => {
    // 1 台目: 同期ありのボルトを作り、パスキーを登録してサーバーへ送る。
    const contextA = await browser.newContext(CONTEXT);
    const pageA = await contextA.newPage();
    const client = await pageA.context().newCDPSession(pageA);
    await client.send('WebAuthn.enable', { enableUI: false });
    await client.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
        hasPrf: true,
      },
    });

    await pageA.goto(`${ORIGIN}/`);
    await expect(pageA.getByRole('heading', { name: 'ボルトをつくる' })).toBeVisible();
    await pageA.getByLabel('マスターパスワード', { exact: true }).fill(PASSWORD);
    await pageA.getByLabel('マスターパスワード（確認）').fill(PASSWORD);
    await pageA.getByRole('radio', { name: /同期する/ }).check();
    await pageA.getByRole('button', { name: 'ボルトを作成' }).click();
    const code = pageA.getByTestId('sync-code');
    await expect(code).toBeVisible();
    const token = (await code.textContent())?.replace(/\s+/g, '') ?? '';
    expect(token).not.toBe('');
    await pageA.getByRole('button', { name: '保管しました' }).click();

    await pageA.getByRole('link', { name: '設定', exact: true }).click();
    await pageA.getByTestId('passkey-name-input').fill('MacBook の指紋');
    await pageA.getByTestId('passkey-register').click();
    await expect(pageA.getByTestId('passkey-name')).toHaveText('MacBook の指紋');
    // 名前だけの一覧をサーバーへ送る（デバウンス 2 秒 + 送信の完了を待つ）。
    await expect(pageA.getByTestId('sync-status')).toHaveText('同期済み', { timeout: 20_000 });

    // 2 台目: 同じボルトに同期コードで接続する。パスキーはこの端末には無い。
    const contextB = await browser.newContext(CONTEXT);
    const pageB = await contextB.newPage();
    await pageB.goto(`${ORIGIN}/sync`);
    await expect(pageB.getByRole('heading', { name: '同期コードを入力' })).toBeVisible();
    await pageB.getByTestId('sync-code-input').fill(token);
    await pageB.getByTestId('sync-connect').click();
    await expect(pageB.getByRole('heading', { name: 'ロック中' })).toBeVisible();
    await unlock(pageB, PASSWORD);

    await pageB.getByRole('link', { name: '設定', exact: true }).click();
    // この端末には解除に使えるパスキーが無い。
    await expect(pageB.getByTestId('passkeys-empty')).toBeVisible();
    // ほかの端末の登録は、名前・端末名・使えない旨の注記つきで出る。
    const other = pageB.getByTestId('passkey-other-list');
    await expect(other).toBeVisible();
    await expect(pageB.getByTestId('passkey-other-name')).toHaveText('MacBook の指紋');
    await expect(pageB.getByTestId('passkey-other-note')).toContainText('この端末では使えません');
    // この端末からは削除できない（削除ボタンはローカルの登録にだけ付く）。
    await expect(pageB.getByTestId('passkey-delete')).toHaveCount(0);
    // 名前をほかの端末と共有しても、解除用の情報は渡っていない。
    await expect(pageB.getByTestId('passkey-unlock')).toHaveCount(0);

    await contextA.close();
    await contextB.close();
  });
});
