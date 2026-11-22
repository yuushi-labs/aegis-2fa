/**
 * アプリシェルのみをキャッシュする Service Worker。
 * - ナビゲーション / アセット: stale-while-revalidate（オフラインでも起動できる）
 * - /api/*: 一切キャッシュしない（ゼロ知識の暗号文を端末の SW キャッシュに残さない）
 *
 * 配置先（/ でも /zekey/ でも）は registration.scope から求める。
 */

const SCOPE = new URL(self.registration.scope).pathname;
const BASE = SCOPE.endsWith('/') ? SCOPE : `${SCOPE}/`;
const INDEX = `${BASE}index.html`;
const API_PREFIX = `${BASE}api/`;
/**
 * ビルド時に vite.config.ts が dist/index.html の参照（エントリ JS / CSS）で置き換える。
 * ハッシュ付きのファイル名はビルドごとに変わるため、一覧を手で書かない。
 * 値は配置先の基準（BASE）からの相対パス。
 */
const PRECACHE_ASSETS = [];
/** ビルド時に vite.config.ts が `-<hash>` を足す（アセットが変わったらキャッシュも作り直す）。 */
const CACHE_VERSION = 'v1';
const CACHE = `zekey-shell-${CACHE_VERSION}`;
const SHELL = [
  BASE,
  INDEX,
  `${BASE}manifest.webmanifest`,
  `${BASE}icon.svg`,
  ...PRECACHE_ASSETS.map((path) => `${BASE}${path}`),
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(API_PREFIX)) return;

  // SPA のナビゲーションはネットワーク優先（新しいビルドを拾う）、失敗時のみキャッシュ。
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // エラー応答（5xx 等）で正常なシェルを上書きしない。
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(INDEX, copy));
          }
          return response;
        })
        .catch(() => caches.match(INDEX).then((cached) => cached ?? Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached ?? Response.error());
      return cached ?? network;
    }),
  );
});
