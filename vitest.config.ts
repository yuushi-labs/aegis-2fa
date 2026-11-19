import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**', 'dist-server/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      // フロントエンド（src/lib）を含めて実測する。UI コンポーネントは Playwright の E2E で検証する。
      include: ['shared/**/*.ts', 'server/**/*.ts', 'src/lib/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        'server/index.ts',
        // ブラウザ専用 API（DOM・Canvas・navigator.clipboard・React）に依存し、
        // Node 上の vitest では実行できない。主要な流れは Playwright の E2E と手動確認で
        // カバーするが、クリップボードの 30 秒自動クリアのように時間依存の挙動は
        // 自動テストの対象外（v1.0.0 の既知の穴）。
        'src/lib/clipboard.ts',
        'src/lib/qr.ts',
        'src/lib/hooks.ts',
        'src/lib/useQrDataUrl.ts',
      ],
      // 下回ったら CI を赤くする（現状: 行 92% / 文 90% / 分岐 83% / 関数 95%）。
      thresholds: {
        lines: 85,
        statements: 85,
        branches: 75,
        functions: 85,
      },
    },
  },
});
