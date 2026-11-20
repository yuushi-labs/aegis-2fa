# セキュリティモデル

Aegis 2FA は「サーバーの保存データを信用しない」前提で作られています。暗号文データベースが
丸ごと漏れても、マスターパスワードを知らない攻撃者は OTP の秘密鍵を復号できません。

ただし **配信コード（このアプリの JavaScript）はサーバーから届きます**。保存済み暗号文の
漏洩に対する保護と、配信コードへの信頼は別の話です。サーバーの root を奪った攻撃者は
配信 JavaScript を差し替え、利用者が次に解錠したときにマスターパスワードを取得できます。
PBKDF2 も同一オリジンの CSP もこの経路は防ぎません。この文書は、何を保証し、何を保証しないかを
明確にします。

## 1. 暗号化の構成

```
master password ──PBKDF2-HMAC-SHA-256(600,000, salt 16B)──► KEK (AES-256-GCM)
                                                              │
random 32B DEK ──────────── AES-256-GCM wrap (AAD "aegis-vault-v1") ──► wrappedDek
                                                              │
DEK ──AES-256-GCM (IV 12B, AAD "aegis-data-v1:<revision>")──► data (ciphertext)
```

| 要素 | 値 | 理由 |
| --- | --- | --- |
| KDF | PBKDF2-HMAC-SHA-256 | WebCrypto で追加依存なしに動く。OWASP 2023 の 600k 反復を採用 |
| 反復回数 | 600,000 | 1 回の解錠で数百 ms。総当たりのコストを 60 万倍にする |
| salt | 16 B ランダム | レインボーテーブルとボルト間の相関を防ぐ |
| DEK | 32 B ランダム | パスワード変更時は DEK を包み直すだけで済む（データ再暗号化が不要） |
| データ暗号 | AES-256-GCM | 認証付き暗号。改ざんは復号時に検出される |
| AAD | `aegis-data-v1:<revision>` | 暗号文と revision の不整合（別 revision の暗号文の混入）を検出する。GCM 自体はリプレイを防がない |
| verifier | HMAC-SHA-256(DEK, "aegis-verify-v1") 先頭 16 B | 誤パスワードを復号前に判定する |

`wrappedDek` と `data` は別々の GCM 鍵で暗号化され、どちらも改ざん検出の対象です。
サーバーは `kdf`（salt, iterations）、`cipher`（iv, wrappedDek）、`data`（iv, ciphertext）、
`revision`、`updatedAt` しか受け取りません。

## 2. 脅威モデル

| 脅威 | 結果 | 対策 |
| --- | --- | --- |
| サーバー侵害（root 奪取） | 攻撃者は暗号文と tokenHash を取得。さらに配信 JavaScript を差し替え可能 | 保存データについては復号鍵（KEK/DEK）は端末のメモリのみ。配信コードの差し替えは防げない（下記「保証しないこと」） |
| DB ダンプの公開 | 同上 | 秘密鍵・パスワード・OTP コードは列に存在しない（統合テストで検証） |
| 通信の傍受 | 暗号文と tokenHash のみ | TLS 前提。`connect-src 'self'` で外部送信を禁止 |
| XSS | アンロック中の秘密鍵が読まれ得る | CSP `script-src 'self'`、`innerHTML` 不使用、React の自動エスケープ |
| クリップボード窃取 | コピーしたコードが読まれ得る | 30 秒後に自動クリア（設定で無効化可） |
| 端末紛失（ロック中） | 暗号文のみ | マスターパスワードが無ければ復号不能 |
| 端末紛失（アンロック中） | 秘密鍵が読まれ得る | 自動ロック（既定 5 分）、タブ非表示で即ロック（任意）。「自動ロック：なし」のときはタブを開いている間 DEK が `sessionStorage` に残る |
| 同期トークン漏洩 | 暗号文の読み書きが可能 | トークンは 256 bit ランダム。サーバーは SHA-256 ハッシュのみ保存 |
| リプレイ / 巻き戻し | 古い暗号文に差し替え | AAD に revision を含め、既存端末はサーバー revision と比較して古い応答を採用しない。初回接続時など比較基準が無い場合は検出できない |

## 3. 保証すること

- **サーバーは平文を知らない。** API ペイロード、SQLite ファイル、ログのいずれにも
  秘密鍵・パスワード・OTP コードは現れない（`tests/integration/vault.test.ts`）。
- **サーバーは同期トークン本体を保存しない。** `tokenHash = SHA-256(token)` のみ。
- **誤ったトークンではボルトの存在すら分からない。** 不一致は 404 を返す。
- **改ざんは検出される。** GCM の認証タグにより、1 bit でも変われば復号に失敗する。
- **外部への送信は無い。** CSP の `connect-src 'self'`、フォントもアイコンも自前で配信。
- **保存済み暗号文は漏れても復号できない。** DB ダンプ・バックアップ・同期 API のいずれも暗号文のみ。

## 4. 保証しないこと（既知の制約）

- **配信コードの改ざん**: このアプリは同じサーバーから SPA を配信します。サーバーの root を
  奪った攻撃者は JavaScript を差し替えて、次回の解錠時にマスターパスワードを取得できます。
  PBKDF2 も同一オリジンの CSP もこの経路を防ぎません。配信元のサーバーは信頼できるものを
  使ってください（静的ホスティングに分離する構成も検討できます）。
- **AAD が検出する範囲**: AAD は「暗号文と revision の不整合」を検出するもので、リプレイ対策
  ではありません。正当な旧 envelope 全体（revision を含む）を再送された場合、復号は成功します。
  既存端末はサーバーの revision と比較して古い応答を採用しませんが、初回接続（`attachSync`）など
  新しさを比較する基準が無い場面では、古い正当な封筒の再提示を検出できません。
- **ブラウザ拡張機能**はページの DOM とメモリにアクセスできます。信頼できる拡張のみを入れてください。
- **メモリダンプ / コールドブート攻撃**: アンロック中は DEK が JS ヒープに存在します。
- **自動ロック「なし」のセッション継続**: この設定のときだけ、DEK を `sessionStorage` に置いて
  同じタブの再読み込みで復帰します（マスターパスワードは保存しません）。このタブで動くスクリプト
  （XSS・拡張機能・DevTools）は DEK を読めます。タブを閉じる・手動でロックする・自動ロックを戻す・
  ボルトを消すと即座に破棄されます。共有端末では「なし」を使わないでください。
- **侵害された端末**: キーロガーやマルウェアが動いている端末では、入力したパスワードは守れません。
- **サーバーによるサービス拒否・削除**: 可用性は保証しません。暗号化バックアップを併用してください。
- **マスターパスワードの忘却**: 復旧手段はありません。これがゼロ知識の代償です。
- **タイミング攻撃の完全な排除**: 比較は定数時間実装ですが、ブラウザの JIT 最適化までは制御できません。
- **マルチテナント分離**: 単一ユーザー / 小規模チーム向けの設計です。監査ログや RBAC はありません。
- **復号失敗の原因を区別しない**: AES-GCM の認証タグ不一致（改ざん・ビット化け）も
  「パスワードが違います」として扱います。壊れたデータは 5 回でクールダウンに入り、
  整合性違反であることが画面に出ません（バックアップからの復元が有効です）。
- **解錠の試行制限はメモリのみ**: 5 回失敗で 30 秒のクールダウンはページ再読み込みで
  リセットされます。ローカル封筒に対する総当たりの主防御は PBKDF2 600,000 回です。
- **同期データの項目検証は最小限**: 同期マージやバックアップから取り込んだ `accounts` は
  形だけを検査します。細工された `period` や `digits` は表示・コード生成の失敗として
  現れますが、XSS には至りません（`innerHTML` 系の DOM シンクは使用していません）。
- **CI のアクションは可変タグ参照**: `actions/*@v4` 等を使用しています。サプライチェーン
  対策として SHA 固定が望ましく、未対応です。

## 5. サーバー側の防御

- セキュリティヘッダ: CSP、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、
  `Referrer-Policy: no-referrer`、`Cross-Origin-Opener-Policy: same-origin`、
  `Cross-Origin-Resource-Policy: same-origin`、`Permissions-Policy`（カメラのみ self）。
- HTTPS 運用時は HSTS（`AEGIS_HTTPS=true`）。
- レート制限: 読み取り 60 req/min、書き込み 20 req/min（IP 単位、`429` + `Retry-After`）。
  `TRUST_PROXY=true` のときは `X-Forwarded-For` を**右端から** `TRUST_PROXY_HOPS` 番目の
  値で識別する（左端はクライアントが偽装できるため採用しない）。`X-Real-IP` は読まない。
  前段のプロキシが `X-Forwarded-For` を設定または上書きする構成が前提。
- 保存の同一性: `vaultId = hex(SHA-256(token))[0:32]` を書き込み時に検証し、トークンから
  導出できない ID は `404`（任意 ID の作成・名前空間の占有を防ぐ）。
- 保存量の上限: 暗号文の総量が `MAX_VAULT_BYTES`（既定 256 MiB）を超える書き込みは `507`。
- 破損した行: 保存された封筒が JSON として読めない場合は `500` ではなく `409 corrupt_vault`。
  JSON としては読めるが暗号文が壊れている場合は `200` を返し、復号はクライアント側で失敗する
  （`docs/SECURITY.md` の「保証しないこと」にあるとおり、原因は「パスワード誤り」として扱われる）。
- 入力検証: すべてのボディを zod で検証。256 KiB を超えるボディは `413`。
- エラーレスポンスは本番で内部情報を出さない（`internal_error`）。
- `Cache-Control: no-store` を `/api/*` に付与。

## 6. 鍵導出パラメータの根拠

PBKDF2 600,000 回は OWASP Password Storage Cheat Sheet（2023）の推奨値です。
GPU を用いた PBKDF2-HMAC-SHA-256 の攻撃速度はおよそ 10^7 hash/s/W 級とされ、
12 文字以上のランダムなパスワードであれば現実的な時間での総当たりは成立しません。
Argon2id の方が GPU 耐性は高いものの、追加の WASM 依存（約 100 KB）とブラウザ間の
挙動差を避けるため、WebCrypto 標準の PBKDF2 を選択しました。

反復回数はボルトの `kdf.iterations` に保存されるため、将来引き上げても既存ボルトは
解錠できます（解錠後に新しい値で包み直すマイグレーションを追加可能）。

## 7. 脆弱性の報告

セキュリティ上の問題は公開 Issue ではなく、リポジトリの Security Advisories
（Private vulnerability reporting）からご連絡ください。

## 8. 自動監査と外部監査の位置づけ

v1.0.0 は**第三者による外部セキュリティ監査を受けていません**。下記は自動・内部で実施した
チェックであり、「監査済み」を意味しません。外部監査を依頼する場合の前提もここに整理します。

| チェック | 内容 | 実行タイミング |
| --- | --- | --- |
| 依存関係の脆弱性 | `pnpm audit --audit-level=high`（CI `audit` ジョブ）。high 以上で CI が失敗する | push / pull_request |
| 依存の更新追従 | Dependabot（npm・GitHub Actions・Docker ベースイメージ、週次）。メジャー更新は自動 PR にせず手動で判断 | 週次 |
| セキュリティ監査スキル | Cloudflare の `security-audit` スキル（OpenHands のマーケットプレイス `security-audit-skill`）で暗号・API・クライアント・Docker・CI を点検 | v1.0.0 準備時 |
| 静的検査・型検査 | ESLint（`no-explicit-any` 等）、TypeScript strict、`tsc --noEmit` | push / pull_request |
| 統合テスト | サーバー API と SQLite に平文の秘密鍵・パスワード・OTP コードが現れないことを検証 | push / pull_request |
| E2E | Playwright で主要フロー・2 端末同期・モバイル幅・CSP・Service Worker を検証 | push / pull_request |
| コンテナ | マルチステージビルド。runtime に devDependencies を含めないことと `/api/health` の応答を CI で検証 | push / pull_request |

### v1.0.0 時点の依存関係監査

- high / critical: 0 件（`pnpm audit --audit-level=high` が成功する状態でリリース）。
- moderate: 残存あり。`drizzle-kit` が間接的に使う `esbuild <= 0.24.2` のみで、開発時の
  マイグレーション生成にしか使わず配布物には含まれない。上流の更新が出たら追従する。
- v1.0.0 準備時に解消したもの:
  - `vitest` 3.2.7 → 4.1.12（`tinypool` の critical 2 件、`@vitest/mocker` の path traversal を解消）
  - `zod` 3.25.76 → 4.6.7（GHSA-mrhx-c7xc-m3w5: 過大な制約付きコレクションでメモリを枯渇させる問題）

### v1.0.0 準備時の Cloudflare `security-audit` 点検

OpenHands 上で `security-audit` スキル（Cloudflare の `security-audit-skill`）を使い、
`src/`・`server/`・`shared/`・`Dockerfile`・`ci.yml` をレビューしました（単一パス、独立再検証なし）。

結果: **Critical 0 件 / High 2 件 / Medium 3 件 / Low 6 件 / Info 3 件**。
暗号設計（PBKDF2 600k、AES-256-GCM、KEK/DEK 分離、AAD への revision バインド、定数時間比較）は
健全と評価され、指摘はサーバー側のレート制限・リソース境界と同期トークンの扱いに集中しました。

| 指摘 | 対応 |
| --- | --- |
| High: `TRUST_PROXY=true` で `X-Forwarded-For` 偽装によりレート制限を回避 | 修正（右端ホップを採用、`TRUST_PROXY_HOPS`） |
| High: 未認証で任意 ID のボルト行を作成でき、ディスクを消費 | 修正（`vaultId` の導出検証 + `MAX_VAULT_BYTES`） |
| Medium: 同期トークンが `?code=` で URL に残る | 修正（読み取り直後に `history.replaceState`） |
| Medium: 「ボルトを削除」がサーバー側の暗号文を消さない | 修正（`wipe` で DELETE を試行） |
| Medium: サーバーが `vaultId = SHA-256(token)` を検証しない | 修正（上記 High と同じ対応） |
| Low: 壊れた封筒で GET が 500 | 修正（`409 corrupt_vault`） |
| Low: `changePassword` がパスワード長を検証しない | 修正（`MIN_PASSWORD_LENGTH` 未満は拒否） |
| Low: runtime イメージに devDependencies（678 MB） | 修正（301 MB、CI で非同梱を検証） |
| Low: 復号失敗がすべて「パスワード誤り」／解錠回数がメモリのみ／`accounts` の項目検証が最小限 | 未対応（上記「保証しないこと」に明記） |
| Info: CI アクションが可変タグ参照 | 未対応（Dependabot で追従） |

### 外部監査を依頼する場合の前提

- 対象は `v1.0.0` タグ時点のソース、`Dockerfile`、本ドキュメントの脅威モデル。
- 秘密情報は含まれない（サーバーは暗号文と `tokenHash` のみ保持）。再現手順は README の
  Docker 手順で完結し、外部サービスへの依存はない。
- 監査で判明した問題は、修正版を `v1.0.1` 以降として公開し、本ドキュメントに追記する。
