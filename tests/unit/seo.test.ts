import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SITE_ORIGIN,
  buildRobotsTxt,
  buildSitemapXml,
  homeUrl,
  normalizeBasePath,
  pageUrl,
  resolveSiteOrigin,
  siteUrl,
} from '../../scripts/seo';
import { APP_NAME, HOME_TITLE, canonicalUrlFor, documentTitleFor } from '../../src/lib/seo';

describe('normalizeBasePath', () => {
  it('未指定・空・/ はルート配信として扱う', () => {
    expect(normalizeBasePath(undefined)).toBe('/');
    expect(normalizeBasePath('')).toBe('/');
    expect(normalizeBasePath('/')).toBe('/');
    expect(normalizeBasePath('  /  ')).toBe('/');
  });

  it('サブディレクトリは前後のスラッシュを揃える', () => {
    expect(normalizeBasePath('aegis')).toBe('/aegis/');
    expect(normalizeBasePath('/aegis')).toBe('/aegis/');
    expect(normalizeBasePath('/aegis/')).toBe('/aegis/');
  });
});

describe('resolveSiteOrigin', () => {
  it('未指定なら本番の Xserver を使う', () => {
    expect(resolveSiteOrigin(undefined)).toBe(DEFAULT_SITE_ORIGIN);
    expect(resolveSiteOrigin('   ')).toBe(DEFAULT_SITE_ORIGIN);
  });

  it('http(s) のオリジンを受け付け、末尾のスラッシュを落とす', () => {
    expect(resolveSiteOrigin('https://example.com/')).toBe('https://example.com');
    expect(resolveSiteOrigin('http://localhost:4173')).toBe('http://localhost:4173');
  });

  it('パス付き・相対 URL・http(s) 以外は設定ミスとして弾く', () => {
    expect(() => resolveSiteOrigin('https://example.com/aegis')).toThrow(/オリジンだけ/);
    expect(() => resolveSiteOrigin('example.com')).toThrow(/URL として読めません/);
    expect(() => resolveSiteOrigin('ftp://example.com')).toThrow(/http\(s\)/);
  });
});

describe('URL の組み立て', () => {
  it('ルート配信はオリジンそのもの', () => {
    expect(siteUrl('https://example.com', '/')).toBe('https://example.com');
    expect(homeUrl('https://example.com', '/')).toBe('https://example.com/');
    expect(pageUrl('https://example.com', '/', 'privacy')).toBe('https://example.com/privacy');
  });

  it('サブディレクトリ配信でも二重スラッシュにならない', () => {
    expect(siteUrl('https://example.com', '/aegis/')).toBe('https://example.com/aegis');
    expect(homeUrl('https://example.com/', 'aegis')).toBe('https://example.com/aegis/');
    expect(pageUrl('https://example.com', '/aegis/', '/privacy')).toBe(
      'https://example.com/aegis/privacy',
    );
    expect(pageUrl('https://example.com', '/aegis/', '')).toBe('https://example.com/aegis/');
  });
});

describe('robots.txt', () => {
  it('全体を許可し、API だけを除外してサイトマップを示す（サブディレクトリ配信）', () => {
    const robots = buildRobotsTxt('https://yuushi0911.xsrv.jp', '/aegis/');
    expect(robots).toContain('User-agent: *');
    expect(robots).toContain('Allow: /');
    expect(robots).toContain('Disallow: /aegis/api/');
    expect(robots).toContain('Sitemap: https://yuushi0911.xsrv.jp/aegis/sitemap.xml');
    // `Disallow: /` のような全体ブロックが残っていないこと。
    expect(robots).not.toMatch(/^Disallow: \/$/m);
    expect(robots.endsWith('\n')).toBe(true);
  });

  it('ルート配信では /api/ を除外する', () => {
    expect(buildRobotsTxt('https://example.com', '/')).toContain('Disallow: /api/');
    expect(buildRobotsTxt('https://example.com', '/')).toContain(
      'Sitemap: https://example.com/sitemap.xml',
    );
  });
});

describe('sitemap.xml', () => {
  it('ホームとプライバシーポリシーを絶対 URL で並べる', () => {
    const xml = buildSitemapXml('https://yuushi0911.xsrv.jp', '/aegis/', { lastmod: '2026-11-22' });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<loc>https://yuushi0911.xsrv.jp/aegis/</loc>');
    expect(xml).toContain('<loc>https://yuushi0911.xsrv.jp/aegis/privacy</loc>');
    expect(xml).toContain('<lastmod>2026-11-22</lastmod>');
    expect(xml).toContain('<priority>1.0</priority>');
    expect(xml.match(/<url>/g)).toHaveLength(2);
    // base とパスの境目でスラッシュが重複（/aegis//privacy）しないこと。
    expect(xml).not.toContain('/aegis//');
    expect(xml.trimEnd().endsWith('</urlset>')).toBe(true);
  });

  it('lastmod の既定は今日（UTC）', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(buildSitemapXml('https://example.com', '/')).toContain(`<lastmod>${today}</lastmod>`);
  });

  it('ルート配信ではオリジン直下の URL になる', () => {
    const xml = buildSitemapXml('https://example.com', '/', { lastmod: '2026-11-22' });
    expect(xml).toContain('<loc>https://example.com/</loc>');
    expect(xml).toContain('<loc>https://example.com/privacy</loc>');
  });

  it('base に & などが入っても XML として壊れない', () => {
    const xml = buildSitemapXml('https://example.com', '/r&d/', { lastmod: '2026-11-22' });
    expect(xml).toContain('<loc>https://example.com/r&amp;d/</loc>');
    expect(xml).not.toContain('/r&d/');
  });
});

describe('documentTitleFor（画面ごとのタイトル）', () => {
  it('読み込み中は初期 HTML のタイトルを残す（null）', () => {
    expect(documentTitleFor('/', 'loading', 'ja')).toBeNull();
  });

  it('ホームは検索意図を含む長いタイトル', () => {
    expect(documentTitleFor('/', 'unlocked', 'ja')).toBe(HOME_TITLE.ja);
    expect(documentTitleFor('/', 'unlocked', 'en')).toBe(HOME_TITLE.en);
    expect(HOME_TITLE.ja).toContain('2段階認証');
  });

  it('プライバシーポリシーは状態に関わらずページ名を出す', () => {
    const expected = `プライバシーポリシー | ${HOME_TITLE.ja}`;
    expect(documentTitleFor('/privacy', 'uninitialized', 'ja')).toBe(expected);
    expect(documentTitleFor('/privacy', 'locked', 'ja')).toBe(expected);
    expect(documentTitleFor('/privacy/', 'unlocked', 'ja')).toBe(expected);
    expect(documentTitleFor('/privacy', 'unlocked', 'en')).toBe(
      `Privacy policy | ${HOME_TITLE.en}`,
    );
  });

  it('解錠前は「いま何を求められているか」をタイトルにする', () => {
    expect(documentTitleFor('/accounts', 'locked', 'ja')).toBe(`ロック中 | ${HOME_TITLE.ja}`);
    expect(documentTitleFor('/accounts', 'uninitialized', 'ja')).toBe(
      `ボルトをつくる | ${HOME_TITLE.ja}`,
    );
    // 同期画面は解錠前でも開けるので、同期のタイトルのまま。
    expect(documentTitleFor('/sync', 'locked', 'ja')).toBe(`同期 | ${HOME_TITLE.ja}`);
  });

  it('解錠後の各画面', () => {
    expect(documentTitleFor('/add', 'unlocked', 'ja')).toBe(`アカウントを追加 | ${HOME_TITLE.ja}`);
    expect(documentTitleFor('/settings', 'unlocked', 'ja')).toBe(`設定 | ${HOME_TITLE.ja}`);
    expect(documentTitleFor('/trash', 'unlocked', 'ja')).toBe(`ゴミ箱 | ${HOME_TITLE.ja}`);
    expect(documentTitleFor('/print', 'unlocked', 'ja')).toBe(
      `緊急バックアップ印刷シート | ${HOME_TITLE.ja}`,
    );
    expect(documentTitleFor('/account/abc123', 'unlocked', 'ja')).toBe(
      `アカウントの詳細 | ${HOME_TITLE.ja}`,
    );
    expect(documentTitleFor('/settings', 'unlocked', 'en')).toBe(`Settings | ${HOME_TITLE.en}`);
  });

  it('未知のパスはホームのタイトルに戻す（解錠後は / へリダイレクトされる）', () => {
    expect(documentTitleFor('/unknown', 'unlocked', 'ja')).toBe(HOME_TITLE.ja);
  });

  it('アプリ名は manifest と同じ', () => {
    expect(APP_NAME).toBe('Aegis 2FA');
  });
});

describe('canonicalUrlFor（canonical の絶対 URL）', () => {
  it('ルート配信', () => {
    expect(canonicalUrlFor('https://example.com', '/', '/')).toBe('https://example.com/');
    expect(canonicalUrlFor('https://example.com', '/', '/privacy')).toBe(
      'https://example.com/privacy',
    );
  });

  it('サブディレクトリ配信（/aegis/）では /privacy を独立させる', () => {
    const origin = 'https://yuushi0911.xsrv.jp';
    expect(canonicalUrlFor(origin, '/aegis/', '/')).toBe('https://yuushi0911.xsrv.jp/aegis/');
    expect(canonicalUrlFor(origin, '/aegis/', '/privacy')).toBe(
      'https://yuushi0911.xsrv.jp/aegis/privacy',
    );
    // 末尾スラッシュ・base の書き方の揺れを吸収する。
    expect(canonicalUrlFor(origin, 'aegis', '/privacy/')).toBe(
      'https://yuushi0911.xsrv.jp/aegis/privacy',
    );
  });

  it('ボルトの中身にあたる画面はホームに寄せる（重複索引を避ける）', () => {
    const origin = 'https://yuushi0911.xsrv.jp';
    for (const path of ['/settings', '/add', '/trash', '/print', '/sync', '/account/abc', '/unknown']) {
      expect(canonicalUrlFor(origin, '/aegis/', path)).toBe('https://yuushi0911.xsrv.jp/aegis/');
    }
  });
});
