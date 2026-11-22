# AGENTS.md — 作業規約

このリポジトリは仕様駆動で開発する。実装前に必ず `SPEC.md` を全文読むこと。仕様と矛盾する実装をする場合は、先に `SPEC.md` を更新して理由を PR 本文に書く。

## コマンド

```bash
pnpm install --frozen-lockfile   # 依存（lockfile は必ずコミット）
pnpm dev                         # Vite dev + API（同時起動）
pnpm lint                        # ESLint
pnpm typecheck                   # tsc --noEmit
pnpm test                        # Vitest（unit + integration）
pnpm test:e2e                    # Playwright（要 pnpm build）
pnpm build                       # SPA + サーバーをビルド（dist/ と dist-server/）
pnpm start                       # 本番サーバー起動
```

## 規約

- TypeScript strict。`any` 禁止（`unknown` + 型ガード）。`@ts-ignore` 禁止。
- 秘密情報（secret, パスワード, OTP コード）を `console.log` に出さない。テストのフィクスチャ以外で平文をファイルに書かない。
- サーバー側コードは `process.env` 以外から設定を読まない。`DATABASE_PATH` はディレクトリ作成込みで扱う。
- クライアントから外部オリジンへリクエストを送らない（フォント・アイコン・解析すべて自前）。CSP `connect-src 'self'` を破らない。
- コミットは Conventional Commits（`feat:`, `fix:`, `test:`, `docs:`, `chore:`）。1 コミット 1 論点。
- 変更は `feat/zekey-2fa-mvp` のような作業ブランチに積み、`main` へ PR を出す。PR 本文に「実装内容 / テスト結果（コマンドと出力要約）/ 未対応・制約」を書く。
- CI が赤いまま完了報告しない。落ちたジョブのログを読み、原因を直して再実行する。
- 依存追加は最小限。追加したら `pnpm-lock.yaml` をコミットし、PR 本文に理由を書く。
