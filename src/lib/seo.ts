/**
 * 画面ごとの `document.title`。
 *
 * SPA は初期 HTML を 1 枚しか持たないため、そのままだと `/privacy` などを開いても
 * タイトルが「Aegis 2FA」のままになる（タブ・ブックマーク・検索結果で区別できない）。
 * ルートとボルトの状態からタイトルを決め、App が `document.title` へ反映する。
 *
 * 初期 HTML 側のタイトル（検索エンジンが見るもの）は index.html にある。
 * ここは遷移後の表示だけを担当する。
 */

import type { Language } from './i18n';
import type { VaultStatus } from './vaultStore';

/** アプリ名（manifest と揃える）。 */
export const APP_NAME = 'Aegis 2FA';

/** ホームのタイトル（検索意図を含む長い方）。 */
export const HOME_TITLE: Record<Language, string> = {
  ja: 'Aegis 2FA — ゼロ知識E2EEの2段階認証アプリ',
  en: 'Aegis 2FA — Zero-knowledge two-factor authenticator',
};

/** 画面名（タイトルの前半）。 */
const PAGE_LABELS: Record<string, Record<Language, string>> = {
  '/': HOME_TITLE,
  '/add': { ja: 'アカウントを追加', en: 'Add account' },
  '/settings': { ja: '設定', en: 'Settings' },
  '/trash': { ja: 'ゴミ箱', en: 'Trash' },
  '/print': { ja: '緊急バックアップ印刷シート', en: 'Printable backup sheet' },
  '/sync': { ja: '同期', en: 'Sync' },
  '/privacy': { ja: 'プライバシーポリシー', en: 'Privacy policy' },
  '/account': { ja: 'アカウントの詳細', en: 'Account details' },
};

/** ボルトの状態に応じた画面名（解錠前の画面）。 */
const STATUS_LABELS: Record<'locked' | 'uninitialized', Record<Language, string>> = {
  locked: { ja: 'ロック中', en: 'Locked' },
  uninitialized: { ja: 'ボルトをつくる', en: 'Create a vault' },
};

/** タイトルの区切り（英語は `|`、日本語も同じ表記で読みやすい）。 */
function join(prefix: string, language: Language): string {
  // ホームとプライバシーポリシーはアプリ名を説明つきで見せる。
  const suffix = HOME_TITLE[language];
  return prefix === suffix ? prefix : `${prefix} | ${suffix}`;
}

/** `/aegis/` 形式の base を、前後のスラッシュ付きに正規化する（`/` はそのまま）。 */
function normalizeBase(basePath: string): string {
  const trimmed = basePath.replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '/' : `/${trimmed}/`;
}

/**
 * ルートに対応する canonical の絶対 URL。
 *
 * 検索エンジンに索引させたいのは公開ページ（ホームとプライバシーポリシー）だけで、
 * ボルトの中身（アカウント一覧・設定・同期など）は索引対象にしない。
 * 内部の画面はすべてホームを canonical にして、鍵の画面が重複ページとして
 * 索引されるのを避ける。
 */
export function canonicalUrlFor(origin: string, basePath: string, pathname: string): string {
  const root = origin.replace(/\/+$/, '');
  const base = normalizeBase(basePath);
  const home = base === '/' ? `${root}/` : `${root}${base}`;
  const path = pathname.replace(/\/+$/, '');
  return path === '/privacy' ? `${home}privacy` : home;
}

/**
 * ルートとボルトの状態から `document.title` を決める。
 *
 * 読み込み中（`loading`）は初期 HTML のタイトルをそのまま残したいので `null` を返す。
 */
export function documentTitleFor(
  pathname: string,
  status: VaultStatus,
  language: Language,
): string | null {
  if (status === 'loading') return null;

  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : '/';
  const page = PAGE_LABELS[path] ?? (path.startsWith('/account/') ? PAGE_LABELS['/account'] : undefined);

  // プライバシーポリシーはロック中でも未作成でも開ける公開ページなので、常にページ名を出す。
  if (path === '/privacy') {
    const label = PAGE_LABELS['/privacy'];
    return label === undefined ? null : join(label[language], language);
  }

  // 解錠前の画面は、ルートではなく「いま何を求められているか」をタイトルにする。
  if (status === 'locked' && path !== '/sync') return join(STATUS_LABELS.locked[language], language);
  if (status === 'uninitialized' && path !== '/sync') {
    return join(STATUS_LABELS.uninitialized[language], language);
  }

  if (page === undefined) return HOME_TITLE[language];
  return join(page[language], language);
}
