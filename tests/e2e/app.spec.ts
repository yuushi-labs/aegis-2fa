import { test, expect, createVault, unlock, addManualAccount, installFixedClock, PASSWORD, RFC_SECRET } from './helpers';
import { generateTOTP } from '../../shared/totp';
import { encodeMigrationPayload } from '../../shared/migration';

/** RFC 6238 の SHA-1 / 6 桁ベクタ（59 秒 = 94287082 は 8 桁）。 */
const FIXED_TIME = 1_111_111_109; // RFC 6238 の 59 秒ベクタに近い固定時刻

test.describe('Aegis 2FA 基本フロー', () => {
  test('ボルト作成 → アカウント追加 → 固定時刻でコード一致', async ({ page }) => {
    await installFixedClock(page, FIXED_TIME);
    await createVault(page, { sync: false });

    await addManualAccount(page, { issuer: 'GitHub', label: 'octocat', secret: RFC_SECRET });

    await expect(page.getByText('GitHub')).toBeVisible();
    const expected = await generateTOTP(RFC_SECRET, FIXED_TIME, { digits: 6 });
    const row = page.getByTestId('account-row').first();
    await expect(row.getByTestId('otp-code')).toHaveText(expected.replace(/(\d{3})(\d{3})/, '$1 $2'));
  });

  test('ロック → 誤パスワード → 正パスワードで解錠、秘密鍵は localStorage に残らない', async ({ page }) => {
    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: 'Example', label: 'me@example.com', secret: RFC_SECRET });

    await page.getByRole('button', { name: 'ロック' }).click();
    await expect(page.getByRole('heading', { name: 'ロック中' })).toBeVisible();

    await page.getByLabel('マスターパスワード', { exact: true }).fill('wrong-password-value');
    await page.getByRole('button', { name: '解錠する' }).click();
    await expect(page.getByRole('alert')).toContainText('パスワードが違います');

    await page.getByLabel('マスターパスワード', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '解錠する' }).click();
    await expect(page.getByRole('heading', { name: 'アカウント' })).toBeVisible();

    // 平文の秘密鍵・パスワードが永続化領域に存在しないこと（ゼロ知識の証跡）。
    const dump = await page.evaluate(() => {
      const items: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key !== null) items.push(key, localStorage.getItem(key) ?? '');
      }
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const key = sessionStorage.key(i);
        if (key !== null) items.push(key, sessionStorage.getItem(key) ?? '');
      }
      return items.join('\n');
    });
    expect(dump).not.toContain(RFC_SECRET);
    expect(dump).not.toContain(PASSWORD);
  });

  test('検索とピン留め', async ({ page }) => {
    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: 'GitHub', label: 'octocat', secret: RFC_SECRET });
    await addManualAccount(page, { issuer: 'GitLab', label: 'tanuki', secret: 'JBSWY3DPEHPK3PXP' });

    await page.getByTestId('search-input').fill('gitlab');
    await expect(page.getByTestId('account-row')).toHaveCount(1);
    await expect(page.getByTestId('account-row').first()).toContainText('GitLab');

    await page.getByTestId('search-input').fill('');
    const gitlabRow = page.getByTestId('account-row').filter({ hasText: 'GitLab' });
    await gitlabRow.getByRole('button', { name: 'ピン留めする' }).click();
    await expect(page.getByTestId('account-row').first()).toContainText('GitLab');
    await expect(gitlabRow.getByRole('button', { name: 'ピン留めを外す' })).toBeVisible();
  });

  test('バックアップを書き出して復元できる', async ({ page }) => {
    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: 'Backup Co', label: 'user', secret: RFC_SECRET });

    await page.getByRole('link', { name: '設定', exact: true }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /暗号化バックアップ/ }).click();
    const download = await downloadPromise;
    const backupPath = test.info().outputPath('backup.aegis');
    await download.saveAs(backupPath);

    // 端末のボルトを消して、バックアップから復元する。
    await page.getByRole('button', { name: 'ボルトを削除', exact: true }).click();
    await page.getByRole('button', { name: '削除する' }).click();
    await expect(page.getByRole('heading', { name: 'ボルトをつくる' })).toBeVisible();

    await createVault(page, { sync: false });
    await page.getByRole('link', { name: '設定', exact: true }).click();
    await page.getByTestId('backup-file-input').setInputFiles(backupPath);
    const dialog = page.getByRole('dialog', { name: 'バックアップを読み込む' });
    await dialog.getByLabel('マスターパスワード').fill(PASSWORD);
    // 別ボルトのバックアップなので DEK が異なる。置き換えでのみ復元できる。
    await dialog.getByRole('button', { name: '置き換える' }).click();
    await dialog.getByRole('button', { name: '実行する' }).click();

    await unlock(page);
    await expect(page.getByText('Backup Co')).toBeVisible();
  });
});

test.describe('キーボードショートカット', () => {
  test('/ で検索、L でロック、C でコピー', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await createVault(page, { sync: false });
    await addManualAccount(page, { issuer: 'Shortcut', label: 'kbd@example.com', secret: RFC_SECRET });
    await expect(page.getByTestId('otp-code').first()).toBeVisible();

    await page.keyboard.press('/');
    await expect(page.getByRole('searchbox')).toBeFocused();
    await page.keyboard.press('Escape');

    // 選択して C でコピー
    await page.getByTestId('account-row').first().click();
    const shown = (await page.getByTestId('otp-code').first().innerText()).replace(/\s/g, '');
    await page.keyboard.press('c');
    await expect
      .poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\s/g, ''))
      .toBe(shown);

    await page.keyboard.press('l');
    await expect(page.getByRole('heading', { name: 'ロック中' })).toBeVisible();
  });
});

test.describe('PWA', () => {
  test('Service Worker が登録され、/api/* をキャッシュしない', async ({ page }) => {
    await page.goto('/');
    const sw = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.active?.scriptURL ?? null;
    });
    expect(sw).toContain('/sw.js');
    const cached = await page.evaluate(async () => {
      const keys = await caches.keys();
      const names: string[] = [];
      for (const key of keys) {
        const cache = await caches.open(key);
        for (const request of await cache.keys()) names.push(new URL(request.url).pathname);
      }
      return names;
    });
    expect(cached.length).toBeGreaterThan(0);
    expect(cached.filter((path) => path.startsWith('/api/'))).toHaveLength(0);
  });

  test('manifest が配信され、192/512 とマスカブルアイコンを持つ', async ({ request }) => {
    const response = await request.get('/manifest.webmanifest');
    expect(response.status()).toBe(200);
    const manifest = (await response.json()) as {
      name: string;
      icons: { sizes: string; purpose?: string }[];
    };
    expect(manifest.name).toBe('Aegis 2FA');
    expect(manifest.icons.some((icon) => icon.sizes === '192x192')).toBe(true);
    expect(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'maskable')).toBe(true);
  });
});

test.describe('Google Authenticator 一括移行', () => {
  test('otpauth-migration:// から TOTP と HOTP を取り込む', async ({ page }) => {
    const uri = encodeMigrationPayload([
      { secret: RFC_SECRET, name: 'alice@example.com', issuer: 'Migrated', algorithm: 'SHA1', digits: 6, type: 'totp', counter: 0 },
      { secret: 'JBSWY3DPEHPK3PXP', name: 'bob@example.com', issuer: 'Legacy', algorithm: 'SHA1', digits: 6, type: 'hotp', counter: 7 },
    ]);

    await createVault(page, { sync: false });
    await page.getByRole('link', { name: '追加', exact: true }).click();
    await page.getByTestId('tab-migration').click();
    await page.getByTestId('migration-input').fill(uri);
    await page.getByRole('button', { name: '読み取る', exact: true }).click();
    await expect(page.getByText('2 件のアカウントが見つかりました')).toBeVisible();
    await page.getByRole('button', { name: 'インポートする' }).click();

    await expect(page.getByRole('heading', { name: 'アカウント' })).toBeVisible();
    await expect(page.getByTestId('account-row')).toHaveCount(2);
    await expect(page.getByText('Migrated')).toBeVisible();
    await expect(page.getByText('Legacy')).toBeVisible();
  });
});

test.describe('同期（2 端末）', () => {
  test('同じ同期コードで別コンテキストから同じコードが読める', async ({ browser }) => {
    const contextA = await browser.newContext({ locale: 'ja-JP' });
    const pageA = await contextA.newPage();
    const token = await createVault(pageA, { sync: true });
    expect(token).not.toBeNull();
    // 追加は 2 秒デバウンスで送信される。送信完了を待ってから別端末を接続する。
    const pushed = pageA.waitForResponse(
      (response) => response.url().includes('/api/vault/') && response.request().method() === 'PUT',
      { timeout: 15_000 },
    );
    await addManualAccount(pageA, { issuer: 'Synced', label: 'shared@example.com', secret: RFC_SECRET });
    await expect(pageA.getByText('Synced')).toBeVisible();
    expect((await pushed).status()).toBe(200);

    const contextB = await browser.newContext({ locale: 'ja-JP' });
    const pageB = await contextB.newPage();
    await pageB.goto('/');
    await expect(pageB.getByRole('heading', { name: 'ボルトをつくる' })).toBeVisible();
    await pageB.getByRole('link', { name: '接続する' }).click();
    await expect(pageB.getByRole('heading', { name: '同期コードを入力' })).toBeVisible();
    await pageB.getByTestId('sync-code-input').fill(token ?? '');
    await pageB.getByTestId('sync-connect').click();

    await expect(pageB.getByRole('heading', { name: 'ロック中' })).toBeVisible();
    await unlock(pageB);
    await expect(pageB.getByText('Synced')).toBeVisible();

    await contextA.close();
    await contextB.close();
  });
});
