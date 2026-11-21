/**
 * サイト版から Android アプリへボルトを引き渡すディープリンク（「アプリでログイン」）。
 *
 * 形式:
 *   aegis://login#code=<base64url(syncToken)>&dek=<base64url(DEK)>&name=<URL エンコードしたボルト名>
 *
 * - 値はすべてフラグメント（`#`）に置く。フラグメントはサーバーへ送られないので、
 *   アクセスログやリファラにトークン・鍵が残らない。
 * - `code` は同期トークン（それ自体が base64url の 32 バイト）を UTF-8 のまま base64url 化したもの。
 *   アプリ側は base64url デコード → UTF-8 の同期トークン文字列として使う。
 * - `dek` はアンロック中のボルト鍵（32 バイト）を base64url 化したもの。
 * - `name` はボルト（プロファイル）名。表示にだけ使う。
 */

import { bytesToBase64Url, utf8ToBytes } from '../../shared/encoding';

/** `aegis://login#` までの固定部分。 */
export const APP_LOGIN_URL_PREFIX = 'aegis://login#';

export type AppLoginLinkOptions = {
  /** 同期トークン（base64url の文字列）。 */
  token: string;
  /** アンロック中の DEK。 */
  dek: Uint8Array;
  /** ボルト（プロファイル）名。 */
  vaultName: string;
};

/** アプリへ渡すディープリンクを組み立てる。 */
export function buildAppLoginUrl({ token, dek, vaultName }: AppLoginLinkOptions): string {
  const code = bytesToBase64Url(utf8ToBytes(token));
  const key = bytesToBase64Url(dek);
  return `${APP_LOGIN_URL_PREFIX}code=${code}&dek=${key}&name=${encodeURIComponent(vaultName)}`;
}
