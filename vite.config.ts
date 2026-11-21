import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
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

/**
 * 配信する sw.js に、ビルドした index.html が読み込むエントリ JS / CSS を書き込む。
 *
 * ハッシュ付きのファイル名はビルドごとに変わるため、プリキャッシュの一覧を
 * public/sw.js に手で書けない。Service Worker の制御が始まる前に読み込まれた
 * バンドルは fetch ハンドラではキャッシュされず、初回のオフライン起動で画面が
 * 出ないことがあるので、install 時に揃える。アセットの一覧が変わったら
 * キャッシュ名も変えて、古いシェルを activate で捨てる。
 */
function serviceWorkerPrecache(): Plugin {
  let outDir = resolve('dist');
  let base = '/';
  return {
    name: 'aegis-sw-precache',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      base = config.base;
    },
    closeBundle() {
      const swPath = join(outDir, 'sw.js');
      const html = readFileSync(join(outDir, 'index.html'), 'utf8');
      const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)]
        .map((match) => match[1] ?? '')
        .filter((path) => path !== '')
        .filter((path) => path.startsWith(base))
        .map((path) => path.slice(base.length));
      if (assets.length === 0) {
        throw new Error('sw.js のプリキャッシュ対象（JS / CSS）を index.html から見つけられませんでした');
      }
      const list = JSON.stringify(assets);
      const hash = createHash('sha256').update(list).digest('hex').slice(0, 8);
      const sw = readFileSync(swPath, 'utf8');
      const injected = sw
        .replace('const PRECACHE_ASSETS = [];', `const PRECACHE_ASSETS = ${list};`)
        .replace("const CACHE_VERSION = 'v1';", `const CACHE_VERSION = 'v1-${hash}';`);
      if (injected === sw) {
        throw new Error('sw.js のプリキャッシュ差し込み位置が見つかりませんでした');
      }
      writeFileSync(swPath, injected);
    },
  };
}

export default defineConfig({
  base: normalizeBase(process.env.VITE_BASE_PATH),
  plugins: [react(), tailwindcss(), serviceWorkerPrecache()],
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
