import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** API サーバーのポート（dev.mjs と server/index.ts と同じ既定値）。 */
const API_PORT = process.env.PORT ?? '3000';

/**
 * 配信先の基準パス。
 * Xserver のサブディレクトリ配信（https://example.com/aegis/ など）では
 * VITE_BASE_PATH=/aegis/ を指定する（scripts/build-xserver.mjs が設定する）。
 * 既定は '/' なので、Node 版・Docker・E2E の挙動は変わらない。
 */
function normalizeBase(value: string | undefined): string {
  const trimmed = (value ?? '/').trim();
  if (trimmed === '' || trimmed === '/') return '/';
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

export default defineConfig({
  base: normalizeBase(process.env.VITE_BASE_PATH),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: false,
      },
    },
  },
});
