import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number.parseInt(process.env.E2E_PORT ?? '4173', 10);
const HOST = process.env.E2E_HOST ?? '127.0.0.1';
/** CI かどうか（空でない値なら CI とみなす）。 */
const IS_CI = Boolean(process.env.CI);
/** 実行ごとの一時 DB（前回実行のデータを持ち越さない）。 */
const dataRoot = join(tmpdir(), 'aegis-e2e');
const dataDir = join(dataRoot, `run-${process.pid}-${Date.now()}`);
mkdirSync(dataDir, { recursive: true });
const databasePath = join(dataDir, 'e2e.db');

// 前回実行の残骸を消す（メイン設定の読み込み時のみ。失敗しても実行は続ける）。
if (process.env.TEST_WORKER_INDEX === undefined) {
  try {
    for (const entry of readdirSync(dataRoot)) {
      if (join(dataRoot, entry) === dataDir) continue;
      rmSync(join(dataRoot, entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  } catch {
    // 残骸の掃除に失敗しても E2E 自体は続行する。
  }
}

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: IS_CI,
  retries: IS_CI ? 1 : 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: IS_CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://${HOST}:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    // カメラは使わない（QR は画像/貼り付けでテストする）。
    permissions: [],
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], viewport: { width: 375, height: 812 } },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
  webServer: {
    // 本番ビルドを配信する（pnpm build 済みが前提）。
    command: `node dist-server/index.js`,
    url: `http://${HOST}:${PORT}/api/health`,
    // CI では既存サーバーを再利用しない（今回のビルドを必ず検証する）。
    reuseExistingServer: !IS_CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      // 実行ごとの一時 DB。テスト終了後の掃除は globalTeardown で行う。
      DATABASE_PATH: databasePath,
      NODE_ENV: 'test',
    },
  },
});
