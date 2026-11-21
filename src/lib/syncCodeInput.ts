/**
 * 同期コードの受け取り。
 *
 * 入力欄には次のどれが来てもよい。
 * - 同期コードそのもの（4 文字区切りの空白入りも可）
 * - 同期 URL（`/sync?code=…`、`?sync=…`、`#sync=…`、`/sync/<token>`）
 * - アプリのディープリンク（`aegis://sync?code=…` など）
 *
 * QR やクリップボードから来た文字列から、同期コード（トークン）だけを取り出す。
 */

import { isValidSyncToken, normalizeSyncCode } from '../../shared/sync';

/** URL のクエリ・フラグメントで同期コードを表す名前（先に書いたものを優先する）。 */
const TOKEN_PARAM_NAMES = ['code', 'sync', 'token'] as const;

/** 同期コードとして妥当なら正規化して返す。 */
function asToken(value: string): string | null {
  const normalized = normalizeSyncCode(value);
  return isValidSyncToken(normalized) ? normalized : null;
}

function pickParam(query: string): string | null {
  const params = new URLSearchParams(query);
  for (const name of TOKEN_PARAM_NAMES) {
    const value = params.get(name);
    if (value !== null && value.trim() !== '') return value;
  }
  return null;
}

/**
 * URL（または URL 形式の文字列）から同期コードを取り出す。
 * 同期コードが見つからない・妥当でない場合は null。
 */
export function extractSyncCodeFromUrl(input: string): string | null {
  const text = input.trim();
  if (text === '') return null;
  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:/i.test(text) || text.startsWith('/');
  if (!looksLikeUrl) return null;

  let url: URL;
  try {
    // 相対パス（/sync?code=…）も受け取れるよう、ダミーの基底で解決する。
    url = new URL(text, 'https://aegis.invalid');
  } catch {
    return null;
  }

  const fromSearch = pickParam(url.search);
  if (fromSearch !== null) {
    const token = asToken(fromSearch);
    if (token !== null) return token;
  }

  // フラグメントは `#code=…` 形式と、`#<token>` そのものの両方を受け取る。
  const fragment = url.hash.replace(/^#/, '');
  if (fragment !== '') {
    if (fragment.includes('=')) {
      const fromHash = pickParam(fragment);
      if (fromHash !== null) {
        const token = asToken(fromHash);
        if (token !== null) return token;
      }
    } else {
      const token = asToken(fragment);
      if (token !== null) return token;
    }
  }

  // `/sync/<token>` のようなパス形式。
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  const last = segments.at(-1);
  if (last !== undefined) {
    try {
      const token = asToken(decodeURIComponent(last));
      if (token !== null) return token;
    } catch {
      // 壊れたパーセントエンコードは無視する。
    }
  }

  return null;
}

/**
 * QR・貼り付け・手入力のどれでも、文字列から同期コードを取り出す。
 * 同期コードとして解釈できない場合は null。
 */
export function extractSyncCode(input: string): string | null {
  const text = input.trim();
  if (text === '') return null;
  const direct = asToken(text);
  if (direct !== null) return direct;
  return extractSyncCodeFromUrl(text);
}
