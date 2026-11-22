/**
 * 検索エンジン向けファイル（robots.txt / sitemap.xml）と絶対 URL の組み立て。
 *
 * ビルド時に `vite.config.ts` が読み、配信物の直下へ
 *   - robots.txt（API だけを除外し、サイトマップの場所を書く）
 *   - sitemap.xml（公開ページの一覧）
 * を書き出す。base は Vite の `base`（Xserver は `/aegis/`、Node 版は `/`）に合わせる。
 *
 * 公開 URL の既定は本番の Xserver（`https://yuushi0911.xsrv.jp`）。
 * 別のドメインで配信するときはビルド時に `VITE_SITE_ORIGIN` を指定する。
 */

/** 公開サイトの既定オリジン（本番の Xserver）。 */
export const DEFAULT_SITE_ORIGIN = 'https://yuushi0911.xsrv.jp';

/** サイトマップに入れる公開ページ（base からの相対パス）。 */
export const SITEMAP_PATHS = ['', 'privacy'] as const;

/**
 * `base` を `/aegis/` の形に正規化する（`/` はそのまま）。
 *
 * 空文字・`/` はルート配信、`aegis` のような指定も `/aegis/` に揃える。
 */
export function normalizeBasePath(value: string | undefined): string {
  const trimmed = (value ?? '/').trim();
  if (trimmed === '' || trimmed === '/') return '/';
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

/**
 * 公開オリジンを検証して返す（`VITE_SITE_ORIGIN` の上書き用）。
 *
 * 末尾のスラッシュは落とす。パス付き・相対 URL は受け付けない
 * （canonical / og:url / sitemap は `origin + base` で組み立てるため）。
 */
export function resolveSiteOrigin(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return DEFAULT_SITE_ORIGIN;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`VITE_SITE_ORIGIN が URL として読めません: ${trimmed}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`VITE_SITE_ORIGIN は http(s) で指定してください: ${trimmed}`);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(
      `VITE_SITE_ORIGIN にはオリジンだけを指定してください（パスは base で決まります）: ${trimmed}`,
    );
  }
  return url.origin;
}

/** `origin + base` を末尾スラッシュ無しで返す（例: `https://example.com/aegis`）。 */
export function siteUrl(origin: string, base: string): string {
  const normalizedBase = normalizeBasePath(base);
  const root = origin.replace(/\/+$/, '');
  if (normalizedBase === '/') return root;
  return `${root}${normalizedBase.slice(0, -1)}`;
}

/** ホーム（末尾スラッシュあり）の絶対 URL。 */
export function homeUrl(origin: string, base: string): string {
  return `${siteUrl(origin, base)}/`;
}

/** base 内のパスを解決した絶対 URL（`path` は `privacy` など先頭スラッシュ無し）。 */
export function pageUrl(origin: string, base: string, pathname: string): string {
  const relative = pathname.replace(/^\/+/, '');
  return relative === '' ? homeUrl(origin, base) : `${siteUrl(origin, base)}/${relative}`;
}

/**
 * robots.txt の中身。
 *
 * 検索エンジンには全体を許可し、API（`/api/`）だけを除外する。
 * API は認証必須で HTML を返さないため、クロールさせる意味がない。
 */
export function buildRobotsTxt(origin: string, base: string): string {
  const normalizedBase = normalizeBasePath(base);
  return [
    'User-agent: *',
    'Allow: /',
    `Disallow: ${normalizedBase}api/`,
    '',
    `Sitemap: ${siteUrl(origin, normalizedBase)}/sitemap.xml`,
    '',
  ].join('\n');
}

/**
 * XML のテキスト・属性として安全な形にする。
 *
 * base に `&` などが入っても（例: `--base=/r&d/`）sitemap.xml が XML として
 * 壊れないように、`<loc>` は必ずこれを通す。
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * sitemap.xml の中身。
 *
 * `lastmod` はビルド日（省略時は今日）。テストからは固定日を渡す。
 */
export function buildSitemapXml(
  origin: string,
  base: string,
  options: { lastmod?: string } = {},
): string {
  const lastmod = options.lastmod ?? new Date().toISOString().slice(0, 10);
  const entries = SITEMAP_PATHS.map((pathname) => {
    const loc = escapeXml(pageUrl(origin, base, pathname));
    const priority = pathname === '' ? '1.0' : '0.5';
    return [
      '  <url>',
      `    <loc>${loc}</loc>`,
      `    <lastmod>${escapeXml(lastmod)}</lastmod>`,
      '    <changefreq>monthly</changefreq>',
      `    <priority>${priority}</priority>`,
      '  </url>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    '</urlset>',
    '',
  ].join('\n');
}
