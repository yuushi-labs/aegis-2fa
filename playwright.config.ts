import { defineConfig, devices } from '@playwright/test';

const PORT = Number.parseInt(process.env.E2E_PORT ?? '4173', 10);
const HOST = process.env.E2E_HOST ?? '127.0.0.1';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: process.env.CI === 'true',
  retries: process.env.CI === 'true' ? 1 : 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI === 'true' ? [['list'], ['html', { open: 'never' }]] : [['list']],
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
    reuseExistingServer: process.env.CI !== 'true',
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      DATABASE_PATH: './data/e2e.db',
      NODE_ENV: 'test',
    },
  },
});
