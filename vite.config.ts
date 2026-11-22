import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {
  buildRobotsTxt,
  buildSitemapXml,
  homeUrl,
  normalizeBasePath,
  pageUrl,
  resolveSiteOrigin,
  siteUrl,
} from './scripts/seo';

/** API サーバーのポート（dev.mjs と server/index.ts と同じ既定値）。 */
const API_PORT = process.env.PORT ?? '3000';

/**
 * 公開 URL のオリジン。本番は Xserver（既定）。別ドメインで配信するときは
 * `VITE_SITE_ORIGIN=https://example.com` を指定する（scripts/seo.ts を参照）。
 */
const SITE_ORIGIN = resolveSiteOrigin(process.env.VITE_SITE_ORIGIN);

/** package.json のバージョン（JSON-LD の softwareVersion に入れる）。 */
const APP_VERSION: string = (() => {
  const pkg: unknown = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  if (typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string') {
    return pkg.version;
  }
  return '1.0.0';
})();

/**
 * index.html に埋めた絶対 URL のプレースホルダを、ビルド時の base / オリジンで解決する。
 * canonical・OGP・JSON-LD はクローラが絶対 URL を期待するので、配信先に合わせて出す。
 */
function seoHead(): Plugin {
  let base = '/';
  let command: 'build' | 'serve' = 'build';
  let outDir = resolve('dist');
  return {
    name: 'zekey-seo-head',
    configResolved(config) {
      base = normalizeBasePath(config.base);
      command = config.command;
      outDir = resolve(config.root, config.build.outDir);
    },
    transformIndexHtml(html: string): string {
      const values: Record<string, string> = {
        __SITE_ORIGIN__: SITE_ORIGIN,
        __SITE_URL__: siteUrl(SITE_ORIGIN, base),
        __HOME_URL__: homeUrl(SITE_ORIGIN, base),
        __PRIVACY_URL__: pageUrl(SITE_ORIGIN, base, 'privacy'),
        __OG_IMAGE_URL__: pageUrl(SITE_ORIGIN, base, 'og-image.png'),
        __BASE_PATH__: base,
        __APP_VERSION__: APP_VERSION,
      };
      return html.replace(/__[A-Z_]+__/g, (token) => values[token] ?? token);
    },
    closeBundle() {
      // robots.txt / sitemap.xml は配信物の直下に置く（public/ の robots.txt を上書きする）。
      if (command !== 'build') return;
      writeFileSync(join(outDir, 'robots.txt'), buildRobotsTxt(SITE_ORIGIN, base));
      writeFileSync(join(outDir, 'sitemap.xml'), buildSitemapXml(SITE_ORIGIN, base));
    },
  };
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
    name: 'zekey-sw-precache',
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
  // 配信先の基準パス。Xserver のサブディレクトリ配信（https://example.com/zekey/ など）では
  // VITE_BASE_PATH=/zekey/ を指定する（scripts/build-xserver.mjs が設定する）。
  // 既定は '/' なので、Node 版・Docker・E2E の挙動は変わらない。
  base: normalizeBasePath(process.env.VITE_BASE_PATH),
  plugins: [react(), tailwindcss(), serviceWorkerPrecache(), seoHead()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    // 小さな woff2 を data: URL に埋め込まない。CSP は font-src 'self' なので、
    // 埋め込むとブラウザがフォントを拒否してコンソールに CSP 違反が出る
    // （E2E の tests/e2e/seo.spec.ts が違反ゼロを検査している）。
    assetsInlineLimit: (filePath: string) => (filePath.endsWith('.woff2') ? false : undefined),
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
