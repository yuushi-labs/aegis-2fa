/**
 * サービス名（issuer）のクイック候補。
 *
 * よく使うサービスをワンタップで入れるための固定リスト。外部から取得しない
 * （アカウント情報の外部漏洩を避ける）ため、並びも色も端末内で完結する。
 */

export const ISSUER_SUGGESTIONS = [
  'Google',
  'GitHub',
  'Discord',
  'X',
  'Amazon',
  'Microsoft',
  'Apple',
  'Steam',
  'Cloudflare',
  'Notion',
] as const;

export type IssuerSuggestion = (typeof ISSUER_SUGGESTIONS)[number];

/** 現在の issuer が候補のどれかと一致するか（前後空白・大小文字は無視）。 */
export function matchedIssuerSuggestion(issuer: string): IssuerSuggestion | null {
  const normalized = issuer.trim().toLowerCase();
  if (normalized === '') return null;
  return ISSUER_SUGGESTIONS.find((name) => name.toLowerCase() === normalized) ?? null;
}
