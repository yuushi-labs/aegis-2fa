/**
 * アプリシェルのみをキャッシュする Service Worker。
 * - ナビゲーション / アセット: stale-while-revalidate（オフラインでも起動できる）
 * - /api/*: 一切キャッシュしない（ゼロ知識の暗号文を端末の SW キャッシュに残さない）
 *
 * 配置先（/ でも /aegis/ でも）は registration.scope から求める。
 */

const SCOPE = new URL(self.registration.scope).pathname;
const BASE = SCOPE.endsWith('/') ? SCOPE : `${SCOPE}/`;
const INDEX = `${BASE}index.html`;
const API_PREFIX = `${BASE}api/`;
const CACHE = 'aegis-shell-v1';
const SHELL = [BASE, INDEX, `${BASE}manifest.webmanifest`, `${BASE}icon.svg`];

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
