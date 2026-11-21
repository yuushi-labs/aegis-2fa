# Aegis 2FA

**ゼロ知識 E2EE 同期対応の Web 2FA Authenticator。** 秘密鍵はブラウザから出ません。
サーバーに置かれるのは AES-256-GCM の暗号文だけで、復号鍵（マスターパスワード由来の
KEK と DEK）はアンロック中のメモリにしか存在しません。

![アカウント一覧（ライト）](docs/screenshots/accounts-light.png)

<table>
  <tr>
    <td><img src="docs/screenshots/accounts-dark.png" alt="アカウント一覧（ダーク）" /></td>
    <td><img src="docs/screenshots/mobile.png" alt="モバイル 375px" width="300" /></td>
  </tr>
  <tr>
    <td align="center">ダークテーマ</td>
    <td align="center">375px 幅</td>
  </tr>
</table>

## 特徴

- **TOTP / HOTP**: RFC 6238 / RFC 4226 準拠。SHA-1 / SHA-256 / SHA-512、6 桁 / 8 桁、
  任意の period と counter、クロックスキュー補正（±2 ステップ）、次期コードの先出し表示
- **QR**: カメラ読み取り（`getUserMedia` + jsQR）、画像ファイルからの読み取り、QR 生成（PNG 保存可）
- **`otpauth://` URI** のパースと生成（受け取るのは QR 読み取りから。URI の手入力欄は置かない）
- **Google Authenticator 一括移行**: `otpauth-migration://offline?data=...` の Protobuf を
  自前でデコード。未対応アルゴリズムは理由付きでスキップ、重複は検出して選択可能
- **ゼロ知識同期**: PBKDF2-HMAC-SHA-256 600,000 回 + AES-256-GCM（DEK ラップ + データ暗号）
- **ローカル完結モード**: 同期を使わなければネットワーク通信はゼロ
- **ロック / 自動ロック**: 既定 5 分、タブ非表示で即ロック（任意）、クリップボードは 30 秒で自動クリア
- **パスキー / セキュリティキー解除**: WebAuthn PRF 拡張で、指紋・顔認証・FIDO2 キーからも解錠
  （登録情報は端末内のみ。マスターパスワードはそのまま使える）
- **エクスポート**: 暗号化バックアップ（`.aegis`）、CSV（平文・警告付き）、移行 QR
- **Android アプリ連携**: 「📱 アプリでログイン」で、同期コードと DEK を
  `aegis://login#code=…&dek=…&name=…` として渡し、アプリでパスワードを入れ直さずに同じボルトを開く
  （鍵はフラグメントに置くのでサーバー・ログに残らない。未同期なら自動で初回同期してから渡す）
- **Android ネイティブアプリ**: Kotlin + Jetpack Compose。同じゼロ知識同期・TOTP/HOTP・
  QR・移行・ゴミ箱・複数ボルトに加え、指紋/顔認証で解錠、引っ張って同期、ワンタップコピー。
  接続先は `https://yuushi0911.xsrv.jp/aegis` 固定。GitHub Releases からの
  **アプリ内アップデート**（ETag 付き確認・進捗表示・FileProvider 経由のインストーラ）に対応。
  詳細は [docs/ANDROID.md](docs/ANDROID.md)
- **PWA**: インストール可能、オフラインでコード生成（ビルドしたエントリ JS / CSS も install 時にプリキャッシュ）。
  外部 CDN・外部フォント・解析タグなし
- **UI**: アイボリー×チャコール、セリフ見出し＋等幅コード、控えめなモーション。ライト/ダーク、375px 対応

## クイックスタート

```bash
pnpm install --frozen-lockfile
pnpm dev          # http://localhost:5173（Vite + API 同時起動）
```

本番ビルド:

```bash
pnpm build        # dist/（SPA）と dist-server/（Node）
pnpm start        # http://localhost:3000
```

### Docker

```bash
docker compose up --build -d
curl -fsS http://localhost:3000/api/health
```

マルチステージビルドです。runtime イメージには本番依存だけを入れ（devDependencies は
含めません）、非 root 実行、`read_only` ルートFS、ヘルスチェック付きです。
詳細は [docs/DEPLOY.md](docs/DEPLOY.md)。

## 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `PORT` | `3000` | 待ち受けポート |
| `DATABASE_PATH` | `./data/aegis.db` | SQLite ファイル（親ディレクトリは自動作成） |
| `TRUST_PROXY` | `false` | リバースプロキシ配下で `true`。前段が `X-Forwarded-For` を設定／上書きする構成が前提 |
| `TRUST_PROXY_HOPS` | `1` | 信頼するプロキシの段数。`X-Forwarded-For` の**右端**から数える |
| `MAX_VAULT_BYTES` | `268435456`（256 MiB） | 保存できる暗号文の総量。超過する書き込みは `507` |
| `AEGIS_HTTPS` | `false` | TLS 終端が前段にある場合 `true`（HSTS 付与） |
| `CORS_ORIGIN` | 未設定 | 通常は未設定。別オリジンから API を使う場合のみ |
| `AEGIS_DISABLE_RATE_LIMIT` | `false` | E2E 用。`true` で `/api/vault/*` のレート制限を外す（本番では使わない） |

秘密情報の環境変数はありません。サーバーは復号鍵を持たない設計です。

## セキュリティモデル（要約）

```
master password ──PBKDF2-SHA256(600k, salt)──► KEK ──AES-GCM unwrap──► DEK ──AES-GCM──► accounts
```

- サーバーが保存するのは `kdf`（salt, iterations）、`cipher`（iv, wrappedDek）、
  `data`（iv, ciphertext）、`revision`、`updatedAt`、`tokenHash` のみ
- 同期トークン本体は保存されません（`SHA-256(token)` のみ）。不一致は 404 で存在も秘匿
- AAD に revision を含めるため、暗号文と revision の不一致は復号時に検出されます。
  ただし正当な旧 envelope 全体（revision を含む）を再送された場合は AAD では検出できません
  （既存端末はサーバー revision との比較で古い応答を採用しませんが、初回接続時は比較基準がありません）
- CSP `default-src 'self'` / `connect-src 'self'` / `script-src 'self'`、`nosniff`、`DENY`、
  `no-referrer`、COOP/CORP、`no-store`（`/api/*`）、レート制限、zod による入力検証

保証しないこと（ブラウザ拡張、メモリダンプ、侵害された端末、パスワード忘却など）は
[docs/SECURITY.md](docs/SECURITY.md) に明記しています。

## 構成

```
shared/   純粋ロジック（base32 / hotp / totp / otpauth / migration / crypto / merge / sync）
server/   Hono + SQLite(Drizzle)。暗号文の保存と配信のみ
src/      React 19 + Vite + Tailwind 4 のクライアント
tests/    unit（Vitest）/ integration（Hono app.request）/ e2e（Playwright）
deploy/xserver/  PHP + SQLite 版バックエンド（共用サーバー向け。Composer 不要）
android/         Kotlin + Compose のネイティブアプリ（core/ は shared/ と 1:1）
```

データフローと競合解決は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
プライバシーポリシーは [PRIVACY.md](PRIVACY.md)（アプリ内の `/privacy` と同じ内容）。

## 開発コマンド

```bash
pnpm lint         # ESLint
pnpm typecheck    # tsc --noEmit（client + server）
pnpm test         # Vitest（unit + integration）
pnpm build        # SPA + サーバー
pnpm test:e2e     # Playwright（要 pnpm build）
pnpm build:xserver   # Xserver 用の配信物（deploy/xserver/build/aegis/）
pnpm test:xserver    # PHP 版 API の互換テスト（php -S 上で実行）
cd android && ./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleRelease
```

## テスト

| 層 | 内容 |
| --- | --- |
| unit | RFC 4226 / 6238 の公式テストベクタ全一致、Base32 境界、`otpauth` パース、移行 Protobuf、暗号の往復と改ざん検出、マージ規則 |
| integration | 実 SQLite + `app.request`。PUT/GET/meta/DELETE、楽観ロック 409、404 秘匿、バリデーション、413、レート制限 429、セキュリティヘッダ、**DB とペイロードに平文秘密鍵が無いこと**、ログに秘密が出ないこと |
| unit（client） | ボルトストアの世代カウンタ・保存の直列化・競合解決・バックアップ取り込み、IndexedDB 永続化、同期クライアント、表示整形・設定・i18n |
| e2e | 作成 → 追加 → 時刻固定でコード一致、ロック/解錠、検索/ピン、バックアップ書き出しと復元、移行 URI 一括インポート、2 端末同期、アプリでログイン（同期コードの自動発行と案内）、375px レイアウト、ダークのコントラスト、セキュリティヘッダ |
| android（JVM） | RFC 4226 / 6238 の全ベクタ、Base32、`otpauth` 往復、移行 Protobuf（未知 enum・負の batch_id）、**Web 版で作った封筒の復号と verifier 一致**、AAD 改ざん検出、マージ / tombstones、ゴミ箱 30 日、重複、同期コードの抽出、`aegis://login` のフラグメント解析、同期の判断（未変更なら GET・取り込み・マージ）、`PUT` body の契約、更新判定（143 件） |

カバレッジは `pnpm test:coverage` で `shared`・`server`・`src/lib` を対象に計測し、
2026-11 時点で行 92.4% / 分岐 83.3% / 関数 94.9%。下限（行 85%）を下回ると CI が失敗します。

CI（GitHub Actions）は lint/typecheck、unit + integration（カバレッジ下限つき）、
依存関係監査（`pnpm audit --audit-level=high`）、Playwright E2E、Docker ビルドと
smoke test（`/api/health`・devDependencies 非同梱の検証）を push と pull request で実行します。

## リリース

`v*` タグを push すると `.github/workflows/release.yml` が次を作り、GitHub Release に添付します。

| 添付ファイル | 中身 |
| --- | --- |
| `aegis-php-xserver-<tag>.zip` | Xserver 用（`pnpm build:xserver` の成果物）。`public_html/aegis/` に展開 |
| `aegis-android-<tag>.apk` | Android アプリ（`assembleRelease`、固定の配布鍵で署名） |

APK は「提供元不明のアプリ」を許可して端末で開いてインストールします。上書き更新するには
同じ署名鍵が必要なため、CI はリポジトリの `android/keystore/` の鍵で署名します
（Secrets があれば差し替え。詳細は [docs/ANDROID.md](docs/ANDROID.md)）。
v1.1.1 からはアプリ内の「新しいバージョンがあります」からも更新できます（GitHub Releases の
`aegis-android-*.apk` を取得してインストーラに渡します）。

## デプロイ

Docker Compose / Fly.io / Render / VPS + Caddy の手順は [docs/DEPLOY.md](docs/DEPLOY.md)。
Node を使えない共用サーバー（Xserver など）向けの PHP + SQLite 版は
[deploy/xserver/README.md](deploy/xserver/README.md)。

## ライセンス

[MIT](LICENSE) © 2026 金子悠史 (yuushi-labs)
