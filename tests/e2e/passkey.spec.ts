import type { Page } from '@playwright/test';
import { test, expect, PASSWORD, RFC_SECRET } from './helpers';

/**
 * パスキー / セキュリティキー（WebAuthn PRF）の E2E。
 *
 * 認証器は Chrome DevTools Protocol の仮想オーセンティケータで用意する
 * （`WebAuthn.addVirtualAuthenticator` の `hasPrf` で PRF 拡張の有無を切り替える）。
 *
 * WebAuthn の rpId はドメインでなければならない（IP アドレスでは SecurityError）。
 * `playwright.config.ts` の baseURL は 127.0.0.1 なので、この検証だけ同じサーバーを
 * `localhost` で開く（127.0.0.1 と localhost は IndexedDB のオリジンが別なので、
 * ボルトの作成からやり直す）。
 */
const PORT = process.env.E2E_PORT ?? '4173';
const ORIGIN = process.env.E2E_ORIGIN ?? `http://localhost:${PORT}`;

/** PRF 拡張を持つ／持たない仮想オーセンティケータを追加する。 */
async function addVirtualAuthenticator(page: Page, options: { prf: boolean }): Promise<void> {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable', { enableUI: false });
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: options.prf,
    },
  });
}

/** localhost のオリジンでボルトを作り、アカウントを 1 件入れておく。 */
async function createVaultOnLocalhost(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/`);
  await expect(page.getByRole('heading', { name: 'ボルトをつくる' })).toBeVisible();
  await page.getByLabel('マスターパスワード', { exact: true }).fill(PASSWORD);
  await page.getByLabel('マスターパスワード（確認）').fill(PASSWORD);
  await page.getByRole('radio', { name: /この端末だけで使う/ }).check();
  await page.getByRole('button', { name: 'ボルトを作成' }).click();
  await expect(page.getByRole('heading', { name: 'アカウント' })).toBeVisible();

  await page.getByRole('link', { name: '追加', exact: true }).click();
  await page.getByLabel('サービス名', { exact: true }).fill('PasskeyCo');
  await page.getByLabel('アカウント名', { exact: true }).fill('passkey@example.com');
  await page.getByTestId('secret-input').fill(RFC_SECRET);
  await page.getByTestId('save-account').click();
  await expect(page.getByRole('heading', { name: 'アカウント' })).toBeVisible();
}

test.describe('パスキー / セキュリティキーによる解除', () => {
  test('登録 → ロック → パスキーで解除 → 削除、までを一通り', async ({ page }) => {
    await addVirtualAuthenticator(page, { prf: true });
    await createVaultOnLocalhost(page);

    // 設定画面のパスキーのセクションで登録する。
    await page.getByRole('link', { name: '設定', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'パスキー / セキュリティキー' })).toBeVisible();
    await expect(page.getByTestId('passkeys-empty')).toBeVisible();
    await page.getByTestId('passkey-name-input').fill('Pixel の指紋');
    await page.getByTestId('passkey-register').click();
    await expect(page.getByTestId('passkey-name')).toHaveText('Pixel の指紋');
    await expect(page.getByTestId('passkey-count')).toContainText('1');
    await expect(page.getByTestId('passkeys-empty')).toHaveCount(0);

    // 登録は端末（IndexedDB）に残るので、再読み込みしてもロック画面に解除ボタンが出る。
    await page.reload();
    await expect(page.getByRole('heading', { name: 'ロック中' })).toBeVisible();
    const passkeyButton = page.getByTestId('passkey-unlock');
    await expect(passkeyButton).toBeVisible();
    await passkeyButton.click();
    // 解錠されると直前の URL（設定画面）が表示される。
    await expect(page.getByRole('heading', { name: '設定' })).toBeVisible();
    await page.getByRole('link', { name: 'Aegis' }).click();
    await expect(page.getByTestId('otp-code').first()).toBeVisible();

    // 削除すると一覧から消え、ロック画面の解除ボタンも消える。
    await page.getByRole('link', { name: '設定', exact: true }).click();
    await page.getByTestId('passkey-delete').click();
    await expect(page.getByText('このパスキーを削除します')).toBeVisible();
    await page.getByRole('button', { name: '削除する' }).click();
    await expect(page.getByTestId('passkeys-empty')).toBeVisible();

    await page.getByRole('button', { name: 'ロック', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'ロック中' })).toBeVisible();
    await expect(page.getByTestId('passkey-unlock')).toHaveCount(0);
    // マスタパスワードでは引き続き解除できる。
    await page.getByLabel('マスターパスワード', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '解錠する' }).click();
    await expect(page.getByRole('button', { name: 'ロック', exact: true })).toBeVisible();
  });

  test('PRF 非対応のセキュリティキーでは登録を中断してメッセージを出す', async ({ page }) => {
    await addVirtualAuthenticator(page, { prf: false });
    await createVaultOnLocalhost(page);

    await page.getByRole('link', { name: '設定', exact: true }).click();
    await page.getByTestId('passkey-name-input').fill('PRF なしキー');
    await page.getByTestId('passkey-register').click();
    await expect(page.getByTestId('passkey-register-error')).toContainText('PRF');
    // 一覧には何も残らず、解除ボタンも出ない。
    await expect(page.getByTestId('passkeys-empty')).toBeVisible();
    await page.getByRole('button', { name: 'ロック', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'ロック中' })).toBeVisible();
    await expect(page.getByTestId('passkey-unlock')).toHaveCount(0);
  });
});
