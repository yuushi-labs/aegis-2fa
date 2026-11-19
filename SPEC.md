# Aegis 2FA — 仕様書 v1.0

ゼロ知識 E2EE 同期対応の Web 2FA Authenticator（TOTP / HOTP）。
ブラウザだけで秘密鍵を復号し、サーバーには暗号文しか置かない。

- 対象: 個人〜小規模チーム。スマホ・PC の両方で使える PWA。
- UI 言語: 日本語（英語辞書も同梱し、`navigator.language` で自動切替）。
- ライセンス: MIT。

---

## 1. 技術スタック（固定）

| 層 | 採用 |
|---|---|
| フロント | Vite 6 + React 19 + TypeScript (strict) + Tailwind CSS 4 |
| ルーティング | React Router v7（HashRouter ではなく BrowserRouter、サーバーは SPA フォールバック） |
| 状態 | Zustand + TanStack Query（同期 API 用） |
| ローカル保存 | IndexedDB（`idb` ライブラリ）。平文の秘密鍵は「アンロック中のみメモリ」に置き、永続化するのは暗号文のみ |
| API | Hono 4（`@hono/node-server`） |
| DB | SQLite（`better-sqlite3`）+ Drizzle ORM（マイグレーション同梱） |
| QR | `jsqr`（読み取りフォールバック）+ `qrcode`（生成）。`BarcodeDetector` があれば優先 |
| テスト | Vitest（unit / integration）+ Playwright（E2E） |
| パッケージ | pnpm 10（`packageManager` フィールドで固定）、Node 22 |
| 配布 | マルチステージ Dockerfile + docker-compose.yml（単一コンテナで SPA と API を配信） |

リポジトリは pnpm workspace を使わない単一パッケージでよい。`src/` にクライアント、`server/` に API、`shared/` に両者共通の純粋関数（TOTP/HOTP/Base32/otpauth パーサ/暗号）を置く。

```
.
├── index.html
├── vite.config.ts
├── tailwind.config.ts（Tailwind 4 なら CSS 設定でも可）
├── tsconfig.json / tsconfig.node.json
├── package.json
├── Dockerfile
├── docker-compose.yml
├── drizzle.config.ts
├── drizzle/                     # SQL マイグレーション
├── shared/                      # 純粋ロジック（DOM 非依存・テスト容易）
│   ├── totp.ts  hotp.ts  base32.ts  otpauth.ts  migration.ts  crypto.ts  types.ts
├── server/
│   ├── index.ts                 # エントリ（PORT, DATABASE_PATH）
│   ├── app.ts                   # Hono アプリ（テストから inject 可能に）
│   ├── db/schema.ts  db/client.ts  migrate.ts
│   ├── routes/vault.ts  routes/health.ts
│   └── middleware/security.ts  middleware/rateLimit.ts  middleware/bodyLimit.ts
├── src/                         # React クライアント
├── tests/unit/  tests/integration/  tests/e2e/
└── .github/workflows/ci.yml
```

---

## 2. 機能要件

### 2.1 アカウント（TOTP/HOTP）モデル

```ts
type Account = {
  id: string;              // uuid v4
  type: 'totp' | 'hotp';
  issuer: string;          // サービス名（空可）
  label: string;           // アカウント名（メール等）
  secret: string;          // Base32（パディング無し・大文字正規化して保持）
  algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  digits: 6 | 8;
  period: number;          // TOTP のみ。既定 30、1〜300
  counter: number;         // HOTP のみ。0 以上
  pinned: boolean;
  order: number;           // 並び替え用
  createdAt: string;       // ISO8601
  updatedAt: string;
};
```

### 2.2 OTP 生成（RFC 6238 / RFC 4226 完全準拠）

- `shared/hotp.ts`: HMAC（Web Crypto）→ dynamic truncation → 桁数で剰余。RFC 4226 のテストベクタ（secret `12345678901234567890`、カウンタ 0〜9）に一致すること。
- `shared/totp.ts`: `Math.floor(unixSeconds / period)` をカウンタに。RFC 6238 のテストベクタ（SHA-1/256/512、T=59, 1111111109, 1111111111, 1234567890, 2000000000）に一致すること。
  - SHA-256/512 は RFC のシードをそれぞれの長さに拡張したものを使う（テスト側で定義）。
- 表示: 現在コード、残り秒数（円形プログレス）、**次期コード**（次のステップのコードを薄く表示）。
- クロックスキュー補正: 設定で `-2〜+2` ステップ（既定 0）。表示・コピーは補正後のコード。
- コピー: クリップボードへ。`navigator.clipboard` 不可なら `document.execCommand` フォールバック。**30 秒後にクリップボードが同じ値なら自動クリア**（設定で on/off）。
- HOTP: コード表示＋「次のコードへ」ボタン（確認ダイアログ → counter++ → 保存 → コード再生成）。サーバーとクライアントの両方で使う値は常に暗号化ストア側に保存。

### 2.3 インポート / エクスポート

1. **otpauth URI**: `otpauth://totp/Issuer:account?secret=...&issuer=...&algorithm=SHA1&digits=6&period=30` と `otpauth://hotp/...&counter=N` のパースと生成（往復で意味が変わらない）。
   - `secret` は Base32（大文字小文字・空白・`=` パディング許容）。不正なら明示エラー。
   - issuer は label の `Issuer:account` とクエリの `issuer` の両対応（クエリ優先、無ければ label から）。
2. **QR 読み取り**: カメラ（`getUserMedia`、背面優先）で連続スキャン。`BarcodeDetector` 未対応ブラウザは `jsqr` にフォールバック。画像ファイルアップロードからのデコードも可。読み取り結果が otpauth URI ならアカウント追加、`otpauth-migration://` なら一括インポート画面へ。
3. **QR エクスポート**: 個別アカウントの otpauth URI を QR 表示（ダウンロード PNG 可）。全アカウントの一括 QR（Google Authenticator 移行形式）も生成（下記）。
4. **Google Authenticator 移行形式**（`otpauth-migration://offline?data=<base64url>`）:
   - Protobuf を自前デコード（依存追加不要、`shared/migration.ts`）。
     - `MigrationPayload { repeated OtpParameters otp_parameters = 1; int32 version = 2; int32 batch_size = 3; int32 batch_index = 4; int32 batch_id = 5; }`
     - `OtpParameters { bytes secret = 1; string name = 2; string issuer = 3; Algorithm algorithm = 4; DigitCount digits = 5; OtpType type = 6; int64 counter = 7; }`
     - enum: Algorithm { ALGORITHM_UNSPECIFIED=0, SHA1=1, SHA256=2, SHA512=3, MD5=4 } / DigitCount { DIGIT_COUNT_UNSPECIFIED=0, SIX=1, EIGHT=2 } / OtpType { OTP_TYPE_UNSPECIFIED=0, HOTP=1, TOTP=2 }
   - MD5 と不明 enum はスキップし、**スキップ件数を UI に表示**。
   - `data` は base64url（`-`/`_`、パディング有無どちらも）。壊れた入力は「この QR は読み取れませんでした」と明示。
   - 一括インポート時は重複（issuer+label+secret）を検出し、追加/スキップを選べる。
   - エクスポート側: 1 つの URI にまとめるため `batch_size = 1` を書く。移行形式は TOTP の周期を持たないので、
     **30 秒以外の TOTP は含めず**、個別の `otpauth` URI での書き出しへ案内する（周期を黙って 30 に変換しない）。
   - デコード時: `int32` のフィールドは符号付きとして解釈する（`batch_id = -1` 等の負値でも取り込み全体を失敗させない）。
     HOTP の `counter`（`int64`）は 0 以上の安全整数に限り、外れた 1 件だけスキップする。
5. **暗号化バックアップ**（`.aegis` ファイル）: E2EE ボルトの暗号文をそのまま書き出す（下記 2.4 の形式）。インポートはパスフレーズ入力 → 復号 → 置換 or マージ選択。
6. **CSV エクスポート（警告付き）**: 平文 CSV（issuer,label,secret,type,algorithm,digits,period,counter）。実行前に「平文で保存されます」旨の確認。既定では出さない。

### 2.4 暗号化とゼロ知識同期

**方針: サーバーは暗号文・ID・バージョン・時刻以外を持たない。パスワードも同期トークンも保存しない（トークンは SHA-256 ハッシュのみ）。**

- KDF: PBKDF2-HMAC-SHA-256、`iterations = 600_000`、salt 16 bytes ランダム。Web Crypto (`crypto.subtle.deriveKey`)。
  受け入れる反復回数は 100,000〜1,000,000 に制限する（外部の封筒が巨大な値を主張して端末を長時間占有するのを防ぐ）。
- ボルト鍵: ランダム 32 bytes の DEK。DEK を KEK で AES-256-GCM ラップ（12 bytes IV、AAD = `aegis-vault-v1`）。
- データ暗号化: DEK で AES-256-GCM。IV 12 bytes ランダム（毎回新規）。AAD = UTF-8 `aegis-data-v1:<vaultVersion>`。
- ボルト封筒（ローカル IndexedDB とサーバーの両方に置く形式）:

```json
{
  "format": "aegis-vault",
  "version": 1,
  "kdf": { "name": "PBKDF2-SHA256", "iterations": 600000, "salt": "b64" },
  "wrappedKey": { "iv": "b64", "ciphertext": "b64" },
  "data": { "iv": "b64", "ciphertext": "b64" },
  "verifier": "b64",          // HMAC-SHA256(DEK, "aegis-verify-v1") の先頭16バイト。誤パスワード判定用
  "revision": 7,               // クライアントが持つ論理リビジョン
  "updatedAt": "ISO8601"
}
```

- 誤パスワード: GCM 認証失敗または verifier 不一致で「パスワードが違います」。5 回失敗で 30 秒のクールダウン（クライアント側）。
- 同期トークン: 初回作成時に 32 bytes ランダム → base64url。`vaultId = hex(SHA-256(token))[0:32]`。トークンはクライアントの IndexedDB に保存し、別端末へは「同期コード」として手入力/QR で渡す。サーバーは `vaultId` と `tokenHash`（SHA-256 hex 全長）だけ保存。
- 同期 API は `Authorization: Bearer <token>`。サーバーはハッシュ一致で認可（タイミング安全比較）。
- 楽観ロック: 更新時に `revision` を送り、サーバーの現 revision と一致しなければ `409 { currentRevision }`。
  基準にするのは「最後にサーバーと一致した revision」（`syncedRevision`）で、`envelope.revision - 1` ではない
  （デバウンス窓内に複数回編集しても偽の競合にならないようにする）。クライアントは「上書き / 破棄 / マージ」を選ぶ。
  マージはアカウント id 単位の union（同一 id は `updatedAt` が新しい方。同時刻なら内容の安定比較で決め、入力順に依存しない）。
- 削除の扱い: 削除したアカウントは `tombstones`（`{ id, deletedAt }` の配列、暗号文の中に保存）として記録し、
  マージでは id ごとに新しい `deletedAt` を残す。`deletedAt >= updatedAt` のアカウントは結果から取り除き、
  削除が別端末のマージで復活しないようにする。削除後に同じ id で作り直した場合（`updatedAt` が新しい）は残す。
- 自動同期: アンロック中、保存のたびにデバウンス 2 秒で PUT。オフライン時は IndexedDB に貯めてオンライン復帰時に再送。失敗は UI に小さく表示（トースト＋バッジ）。
  保存は 1 本のキューで直列化し、並行保存で先の変更が失われないようにする。ロック時は保留中の同期を破棄せず即時実行する。
- ローカル完結モード: 同期トークンを作らない選択肢を設け、その場合は一切サーバーへ送らない。

### 2.5 ロック / セッション

- 初回起動: ウェルカム → マスターパスワード設定（12 文字以上、強度メーター、確認入力）→ ボルト作成。パスワードは保存しない。忘れた場合の復旧は不可である旨を明示。
- アンロック: パスワード入力、`Enter` で解錠、オートフォーカス。
- 自動ロック: 無操作 5 分（1/5/15/30 分/なし）。`visibilitychange` で「タブを離れたら即ロック」オプション。
- ロック時は秘密鍵・コードをメモリから破棄（参照を null にし、タイマー停止）。
- 画面キャプチャ抑止は不可なので、スクショ注意の一文をロック画面に出す。

### 2.6 UI / UX

- デザイン: **温かみのある、人間が作ったような落ち着いた UI**。AI テンプレート風の紫グラデ・絵文字多用・過剰なグラスモーフィズムは禁止。
  - 基調: アイボリー/生成り（ライト）とチャコール（ダーク）。アクセントは深いティール＋差し色のテラコッタ。
  - タイポ: 見出しはセリフ系（`"Fraunces"` 相当を `@fontsource` で同梱、無理なら system セリフ）、本文はサンセリフ（`Inter` 相当）。外部 CDN からのフォント読み込みは禁止（CSP とプライバシーのため）→ `@fontsource` を npm 依存として同梱。
  - カードは 1px の境界線＋ごく弱い影。角丸 12px。コード表示は等幅（`JetBrains Mono` 相当 or system mono）、数字は `tabular-nums`、6 桁を 3+3 で区切る。
  - ダーク/ライトは `prefers-color-scheme` 追従＋手動切替（設定に保存）。
  - モーション: 150–200ms の控えめなトランジション。`prefers-reduced-motion` 尊重。
- 主要画面: ロック / 初回設定 / アカウント一覧（検索・ピン留め・ドラッグ並び替え） / アカウント追加（手入力・QR・画像・一括移行） / アカウント詳細編集 / 設定（セキュリティ・同期・表示・エクスポート） / 同期コード入力。
- 一覧の行: アイコン（issuer から決定的な色のイニシャルアバター。外部 favicon 取得はしない＝アカウント情報の外部漏洩防止）、issuer、label、コード、残り時間リング、コピーボタン、ピン。
- キーボード: `/` で検索フォーカス、`Esc` でモーダル閉、`L` でロック、`C` で選択中コードをコピー。フォーカスリング常時表示。
- アクセシビリティ: すべての操作要素に見出し/ラベル、`aria-live` でコード更新を読み上げ（既定 off）、コントラスト比 4.5:1 以上。
- PWA: `manifest.webmanifest`（name/short_name/theme_color/icons 192/512 maskable）、Service Worker でアプリシェルのみキャッシュ（API は network-first、`/api/*` をキャッシュしない）。オフラインでもアンロック済みならコード生成可。

### 2.7 サーバー API

| Method | Path | 説明 |
|---|---|---|
| GET | `/api/health` | `{ status: "ok", uptime, version }`（認証不要、DB 到達確認込み） |
| PUT | `/api/vault/:id` | ボルト作成/更新。body `{ envelope, revision }`。成功 `{ revision }`、競合 `409 { currentRevision }` |
| GET | `/api/vault/:id` | 現在の封筒 `{ envelope, revision }`、無ければ 404 |
| DELETE | `/api/vault/:id` | 削除（Bearer 必須）。204 |
| GET | `/api/vault/:id/meta` | `{ revision, updatedAt }` のみ（同期判定用・軽量） |

- 認可: `Authorization: Bearer <token>`。`vaultId` とトークンハッシュの両方が一致したときのみ。不一致は 404（存在を漏らさない）。
- 制限: body 上限 256 KiB（超過 413）、`envelope` の必須フィールド検証（zod）、`revision` は非負整数、`id` は 32 桁 hex。
- レート制限: IP 単位で `/api/vault/*` は 60 req/min、`PUT` は 20 req/min。超過 429 + `Retry-After`。`better-sqlite3` のメモリテーブルでも可（プロセス内 Map + 定期掃除で可）。
- ログ: リクエストメソッド/パス/ステータス/所要時間のみ。**Authorization ヘッダ・body・クエリは絶対にログしない**。`NODE_ENV=production` でスタックトレースを返さない。
- 静的配信: `dist/` を配信し、`/api/*` 以外の未知パスは `index.html`（SPA フォールバック）。`dist/assets/*` は `immutable` キャッシュ、`index.html` は `no-store`。
- ヘッダ（全レスポンス）:
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
    `Permissions-Policy: camera=(self), microphone=(), geolocation=(), interest-cohort=()`,
    `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`,
    `Strict-Transport-Security: max-age=31536000; includeSubDomains`（HTTPS のときのみ）
  - `Cache-Control: no-store` for `/api/*`
- 環境変数: `PORT`（既定 3000）、`DATABASE_PATH`（既定 `./data/aegis.db`）、`TRUST_PROXY`（既定 false）、`CORS_ORIGIN`（既定 未設定＝同一オリジンのみ）。
- graceful shutdown（SIGTERM で server.close → DB close）。

---

## 3. テスト要件

### 3.1 単体（Vitest, `shared/`）
- RFC 4226 の 10 ベクタすべて一致（6 桁）。
- RFC 6238 の SHA-1/256/512 各ベクタ一致、8 桁指定も一致。
- Base32: エンコード/デコード往復、小文字・空白・パディング許容、不正文字で例外。
- otpauth: パース→シリアライズの往復、issuer/label 分離、HOTP counter、欠損パラメータの既定値、不正 URI で例外。
- migration: 手組みの Protobuf バイト列（TOTP 2 件 + HOTP 1 件 + 未知 enum 1 件）をデコードし、件数・フィールド・スキップが正しいこと。base64url パディング無しでも通ること。
- crypto: PBKDF2 派生→暗号化→復号の往復、誤パスワードで失敗、暗号文 1 バイト改変で失敗、IV が毎回異なる、verifier 判定。
- マージ: id 単位 union で `updatedAt` 優先。

### 3.2 統合（Vitest + Hono `app.request`）
- PUT→GET→meta→DELETE の一連、revision 不一致で 409、トークン不一致 404、body 過大 413、`id` 形式不正 400、レート制限 429、ヘッダ（CSP 等）付与、`/api/health` 200。
- **ゼロ知識テスト**: PUT された封筒に秘密鍵（Base32）もマスターパスワードも平文で含まれないこと、サーバー DB ファイルに平文 secret が現れないこと（`fs.readFileSync(dbPath)` に secret 文字列が含まれない）。

### 3.3 E2E（Playwright, 本番ビルドに対して）
1. 初回設定 → ボルト作成 → 一覧が空。
2. 手入力で追加（RFC テスト秘密鍵）→ コードが `page.clock` 固定時刻の期待値と一致 → コピー → トースト表示。
3. リロード → ロック画面 → 誤パスワードでエラー → 正しいパスワードで解錠 → アカウント残存。
4. 検索・ピン留め・削除（確認ダイアログ）。
5. 暗号化バックアップ書き出し → ボルト削除 → インポート → 復元。
6. 同期: 2 つ目のブラウザコンテキストで同期コード入力 → 同じアカウントが見える。
7. レスポンシブ（375x812）でレイアウト崩れなし、コンソールエラーなし。
8. アクセシビリティ: 主要操作がキーボードのみで完了できる。

E2E は `pnpm build && pnpm start`（一時 DB）に対して `playwright.config.ts` の `webServer` で実行。`reuseExistingServer: !process.env.CI`。

---

## 4. CI（GitHub Actions）

`.github/workflows/ci.yml`、`on: [push, pull_request]`、Node 22 + pnpm（corepack）、ジョブ分割:

1. `quality`: `pnpm lint`（ESLint）＋ `pnpm typecheck`（`tsc --noEmit` を client/server/shared で）
2. `test`: `pnpm test -- --coverage`（unit + integration）
3. `e2e`: `pnpm exec playwright install --with-deps chromium` → `pnpm build` → `pnpm test:e2e`（成果物: レポート）
4. `docker`: `docker/build-push-action` でビルドのみ（push なし）、`cache-from/to: gha`

- concurrency で同一ブランチの古い実行をキャンセル。`permissions: contents: read`。
- すべて緑でなければマージ不可（ブランチ保護は main に要求）。

---

## 5. ドキュメント

- `README.md`: スクリーンショット、特徴、クイックスタート（pnpm / Docker）、環境変数、デプロイ例、セキュリティモデルの要約、ライセンス。
- `docs/SECURITY.md`: 脅威モデル（サーバー侵害・DB 漏洩・XSS・クリップボード・端末紛失）、保証すること/しないこと、既知の制約（ブラウザ拡張、メモリダンプ）、鍵導出パラメータの根拠。
- `docs/DEPLOY.md`: Docker Compose / Fly.io / Render / VPS + Caddy の手順、バックアップ、TLS 前提。
- `docs/ARCHITECTURE.md`: データフロー図（Mermaid）、モジュール責務、同期の競合解決。

---

## 6. 受け入れ基準（すべて満たすこと）

- [ ] `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build` / `pnpm test:e2e` がローカルで全て成功
- [ ] RFC 4226・6238 の全テストベクタ一致
- [ ] Google Authenticator 移行 URI の一括インポートが動作（E2E か統合テストで担保）
- [ ] サーバー DB・API ペイロード・ログに平文の secret / パスワードが存在しない（テストで証明）
- [ ] CSP ほかセキュリティヘッダが全レスポンスに付与される（テストで担保）
- [ ] Docker イメージがビルドでき、起動して `/api/health` が 200、SPA が表示される
- [ ] ライト/ダーク、375px 幅で破綻しない
- [ ] README / SECURITY / DEPLOY / ARCHITECTURE が揃っている
- [ ] `main` への PR で CI が全緑、CodeRabbit の指摘が解消済み
