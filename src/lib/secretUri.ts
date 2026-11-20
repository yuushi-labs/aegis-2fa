/**
 * シークレット欄に貼り付けられた otpauth URI の検出と、フォーム下書きへの展開。
 *
 * 手入力フォームの秘密鍵欄に `otpauth://` をそのまま貼ると Base32 として不正になるため、
 * URI を検出したらフォーム全体（サービス名・アカウント名・秘密鍵・詳細設定）へ展開する。
 * 判定と展開を純粋関数に切り出して、コンポーネントと unit テストの両方から使う。
 */

import { parseOtpauthUri, toAccountDraft } from '../../shared/otpauth';
import type { AccountDraft } from './accountDraft';

export type DetectedSecretUri = {
  kind: 'otpauth' | 'migration';
  /** 前後の空白・ゼロ幅文字を落とした URI 本体。 */
  uri: string;
};

/** コピー経由で混ざるゼロ幅文字（BOM を含む）。 */
const ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g;

/**
 * 貼り付けた文字列から URI を取り出す。秘密鍵（Base32）はそのまま返さない。
 * URI でなければ null。
 */
export function detectSecretUri(raw: string): DetectedSecretUri | null {
  const value = raw.replace(ZERO_WIDTH, '').trim();
  if (/^otpauth-migration:\/\//i.test(value)) return { kind: 'migration', uri: value };
  if (/^otpauth:\/\//i.test(value)) return { kind: 'otpauth', uri: value };
  return null;
}

/**
 * otpauth URI をフォームの下書きへ展開する。
 * 解釈できない URI は `OtpauthError` を投げる（呼び出し側で通知する）。
 */
export function draftFromOtpauthUri(uri: string): AccountDraft {
  const parsed = toAccountDraft(parseOtpauthUri(uri));
  return {
    type: parsed.type,
    issuer: parsed.issuer,
    label: parsed.label,
    secret: parsed.secret,
    algorithm: parsed.algorithm,
    digits: parsed.digits,
    period: parsed.period,
    counter: parsed.counter,
  };
}
