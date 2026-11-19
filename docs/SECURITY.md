# セキュリティモデル

Aegis 2FA は「サーバーを信用しない」前提で作られています。サーバーが完全に侵害され、
データベースが丸ごと漏れても、マスターパスワードを知らない攻撃者は OTP の秘密鍵を
復号できません。この文書は、何を保証し、何を保証しないかを明確にします。

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
| AAD | `aegis-data-v1:<revision>` | revision の巻き戻し（ロールバック）を検出する |
| verifier | HMAC-SHA-256(DEK, "aegis-verify-v1") 先頭 16 B | 誤パスワードを復号前に判定する |

`wrappedDek` と `data` は別々の GCM 鍵で暗号化され、どちらも改ざん検出の対象です。
サーバーは `kdf`（salt, iterations）、`cipher`（iv, wrappedDek）、`data`（iv, ciphertext）、
`revision`、`updatedAt` しか受け取りません。

## 2. 脅威モデル

| 脅威 | 結果 | 対策 |
| --- | --- | --- |
| サーバー侵害（root 奪取） | 攻撃者は暗号文と tokenHash を取得 | 復号鍵（KEK/DEK）は端末のメモリのみ。PBKDF2 600k が残る壁 |
| DB ダンプの公開 | 同上 | 秘密鍵・パスワード・OTP コードは列に存在しない（統合テストで検証） |
| 通信の傍受 | 暗号文と tokenHash のみ | TLS 前提。`connect-src 'self'` で外部送信を禁止 |
| XSS | アンロック中の秘密鍵が読まれ得る | CSP `script-src 'self'`、`innerHTML` 不使用、React の自動エスケープ |
| クリップボード窃取 | コピーしたコードが読まれ得る | 30 秒後に自動クリア（設定で無効化可） |
| 端末紛失（ロック中） | 暗号文のみ | マスターパスワードが無ければ復号不能 |
| 端末紛失（アンロック中） | 秘密鍵が読まれ得る | 自動ロック（既定 5 分）、タブ非表示で即ロック（任意） |
| 同期トークン漏洩 | 暗号文の読み書きが可能 | トークンは 256 bit ランダム。サーバーは SHA-256 ハッシュのみ保存 |
| リプレイ / 巻き戻し | 古い暗号文に差し替え | AAD に revision を含め、クライアントが revision を比較する |

## 3. 保証すること

- **サーバーは平文を知らない。** API ペイロード、SQLite ファイル、ログのいずれにも
  秘密鍵・パスワード・OTP コードは現れない（`tests/integration/vault.test.ts`）。
- **サーバーは同期トークン本体を保存しない。** `tokenHash = SHA-256(token)` のみ。
- **誤ったトークンではボルトの存在すら分からない。** 不一致は 404 を返す。
- **改ざんは検出される。** GCM の認証タグにより、1 bit でも変われば復号に失敗する。
- **外部への送信は無い。** CSP の `connect-src 'self'`、フォントもアイコンも自前で配信。

## 4. 保証しないこと（既知の制約）

- **ブラウザ拡張機能**はページの DOM とメモリにアクセスできます。信頼できる拡張のみを入れてください。
- **メモリダンプ / コールドブート攻撃**: アンロック中は DEK が JS ヒープに存在します。
- **侵害された端末**: キーロガーやマルウェアが動いている端末では、入力したパスワードは守れません。
- **サーバーによるサービス拒否・削除**: 可用性は保証しません。暗号化バックアップを併用してください。
- **マスターパスワードの忘却**: 復旧手段はありません。これがゼロ知識の代償です。
- **タイミング攻撃の完全な排除**: 比較は定数時間実装ですが、ブラウザの JIT 最適化までは制御できません。
- **マルチテナント分離**: 単一ユーザー / 小規模チーム向けの設計です。監査ログや RBAC はありません。

## 5. サーバー側の防御

- セキュリティヘッダ: CSP、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、
  `Referrer-Policy: no-referrer`、`Cross-Origin-Opener-Policy: same-origin`、
  `Cross-Origin-Resource-Policy: same-origin`、`Permissions-Policy`（カメラのみ self）。
- HTTPS 運用時は HSTS（`AEGIS_HTTPS=true`）。
- レート制限: 読み取り 60 req/min、書き込み 20 req/min（IP 単位、`429` + `Retry-After`）。
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
