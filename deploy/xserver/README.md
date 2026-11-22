# Xserver（共用サーバー）での運用

Node 版と同じ API を **PHP（8.1 以上）+ SQLite + Apache `.htaccess`** で提供する構成です。
Composer も Node も不要で、ビルドしたファイルをアップロードするだけで動きます。
Xserver の共用レンタルサーバー（Apache 2.4 + PHP-FPM 8.3）を想定していますが、
`.htaccess` と `pdo_sqlite` が使える共用サーバーなら同様に動きます。

```
deploy/xserver/
├── README.md             ← これ
├── config.example.php    ← 設定例（アップロードしない）
├── site/                 ← 公開ディレクトリへ置くもの（ソース）
│   ├── .htaccess         ← ルーティング / 403 / セキュリティヘッダ / キャッシュ
│   ├── api/index.php     ← API のフロントコントローラ
│   ├── app/              ← PHP 本体（.htaccess で 403）
│   └── storage/          ← ローカル設定の置き場（.htaccess で 403）
├── tests/                ← php -S 上で動く互換テスト
└── build/zekey/          ← pnpm build:xserver の出力（これをアップロードする）
```

## 1. 配信物を作る

```bash
pnpm install --frozen-lockfile
pnpm build:xserver                  # 既定: /zekey/ 配置（https://<ドメイン>/zekey/）
pnpm build:xserver -- --base=/      # ドメイン直下に置く場合（WordPress などと同居不可）
```

`deploy/xserver/build/zekey/` に、SPA（`index.html`・`assets/`・`sw.js`・`manifest.webmanifest`）と
PHP バックエンド（`api/`・`app/`）が揃った状態で出力されます。
`app/version.php` は `package.json` のバージョンから生成されます。

サブディレクトリ名を変える場合は `--base=/zekey2/` のように指定し、アップロード先も合わせます。

## 2. アップロード

FTP / SFTP で `deploy/xserver/build/zekey/` の**中身**を `public_html/zekey/` へ置きます。

```
public_html/zekey/
├── .htaccess
├── index.html
├── assets/            ← ハッシュ付きファイル名（immutable キャッシュ）
├── icons/  icon.svg  manifest.webmanifest  og-image.png  robots.txt  sitemap.xml  sw.js
├── api/index.php
├── app/               ← PHP 本体（403）
└── storage/           ← ローカル設定の置き場（403。DB は公開領域外を推奨）
```

`robots.txt` と `sitemap.xml` はビルド時に `scripts/seo.ts` が生成します（手で置かないでください）。
アップロード先のパスは `base` から自動で入るので、`/zekey/` なら
`Disallow: /zekey/api/` と `https://<ドメイン>/zekey/sitemap.xml` になります。

### robots.txt はドメイン直下にも置く

クローラが読むのは `https://<ドメイン>/robots.txt` だけです（RFC 9309 §2.3）。
`public_html/zekey/robots.txt` はそのままでは効かないので、次のどちらかを行います。

1. ビルドした `robots.txt` を `public_html/robots.txt` にもそのまま置く（アプリをドメイン直下に置く場合は不要）
2. ドメイン直下に既存の `robots.txt`（WordPress など）がある場合は上書きせず、生成された
   `robots.txt` の `Disallow:` 行（例: `Disallow: /zekey/api/`。`base` に合わせて自動で入る）を
   **各 User-agent グループに** 追加する。末尾にまとめて追記すると直前のグループにしか
   効かないため、新しい `User-agent: *` グループを作ってそこに書いてもよい。
   `Sitemap:` 行はグループに属しないので、生成された行を 1 行入れれば十分。

追加する前に、直下の `robots.txt` の既存ルールも確認してください。
`Disallow: /`（全体を禁止）があると、API の除外を足してもホームと `/privacy` はクロールされません。
その場合は**アプリの公開ページだけ**を許可します（アプリ以外のパスまで許可しない）。

- `/zekey/` 配置: 各グループに `Allow: /zekey/` を追加（`/zekey/api/` の `Disallow:` がより限定的なので API は除外のまま）
- ルート配置: `Allow: /$` と `Allow: /privacy$` のようにページ単位で許可する
  （`Allow: /` は `Disallow: /` と同じ長さになり、全体を許可してしまう）

より限定的な既存ルールがないかも合わせて確認してください（`robots.txt` はより限定的なルールが優先されます）。

`sitemap.xml` は Search Console から直接送信してもかまいません。

サブFTPを使う場合、接続先を単体の `public_html` にするとドメイン外に置かれることがあります。
`/home/<サーバーID>/<ドメイン>/public_html` を指定してください（既知の落とし穴）。

## 3. 設定（DB は公開ディレクトリの外へ）
**推奨: DB を公開ディレクトリの外に置く。** Xserver は Nginx が静的ファイルを直接配信することがあり、
その場合 `.htaccess` の 403 が効きません（`app/` の PHP は Apache が処理するので 403 が効きます）。

`config.example.php` をコピーして、公開ディレクトリの 1 つ上に `zekey-config.php` として置きます。
`db_path` は **`null` のまま（自動）を推奨**します。旧 `/aegis/` の DB がある場合の引き継ぎが効きます。

```php
<?php
// /home/<サーバーID>/<ドメイン>/zekey-config.php
return [
    'db_path' => null,   // 既定: DOCUMENT_ROOT の親/zekey-data/zekey.db（旧 DB は自動で引き継ぎ）
];
```

DB を別の場所に置きたい場合だけ、絶対パスを書きます（その場合は自動引き継ぎを行いません）。

```php
    'db_path' => '/home/<サーバーID>/zekey-data/zekey.db',
```

- この場所は配信されません（`public_html` の外）。
- 置き場所を変えるときは `.htaccess` に `SetEnv ZEKEY_CONFIG /path/to/zekey-config.php` を追加します。
  旧名の `aegis-config.php` / `AEGIS_CONFIG` も読みます（新しい名前があればそちらを優先）。
- 設定しない場合は、`DOCUMENT_ROOT` の親の `zekey-data/zekey.db` に自動で作ります。
  **旧 `/aegis/` の DB（`aegis-data/aegis.db`）が残っている場合は、初回アクセス時に
  `VACUUM INTO` で `zekey-data/zekey.db` へ写してから新しい場所を使います**（下記 §3.1）。
  そこへ書けない場合は、**黙って公開領域内へ逃げずに設定エラーで停止します**（`error_log` に保存先の例が出ます）。
  `db_path` を明示してください。`.htaccess` の 403 は Apache には効きますが、Xserver の Nginx が
  静的ファイルを直接配信する構成では効かないため、公開領域内の DB は自動配置しません。
- `zekey-data/` は PHP が作れないときがあるので、事前に `mkdir` して権限 `0700` にしておくと確実です。

| 設定キー | 既定値 | 説明 |
| --- | --- | --- |
| `db_path` | 自動（公開領域外の `zekey-data/`） | SQLite ファイルの絶対パス。公開領域内を指定する場合は Nginx の静的配信に注意 |
| `max_vault_bytes` | `268435456`（256 MiB） | 保存できる暗号文の総量。超過は `507` |
| `trust_proxy` | `false` | 前段が `X-Forwarded-For` を設定・上書きする場合のみ `true` |
| `trust_proxy_hops` | `1` | 信頼するプロキシ段数（右端から数える） |
| `trust_proxy_ips` | `['127.0.0.1', '::1']` | `X-Forwarded-For` を信じてよい接続元の IP（カンマ区切りも可）。ここに無い接続元は `REMOTE_ADDR` で数える |
| `https` | `null`（自動判定） | `true` で HSTS を強制、`false` で付けない |
| `cors_origin` | `null` | 別オリジンから API を使う場合のみ |
| `rate_limit` | `true` | `/api/vault/*` 60/分、PUT 20/分 |
| `rate_limit_read_max` / `rate_limit_write_max` | `60` / `20` | 上限回数 |
| `rate_limit_window_seconds` | `60` | ウィンドウ長 |
| `rate_limit_create_max` / `rate_limit_create_window_seconds` | `10` / `3600` | **新規ボルトの作成だけ**の上限（何回/ウィンドウ）。既存ボルトの同期更新は数えない |
| `debug` | `false` | 500 の本文に例外メッセージを含める |

環境変数（`.htaccess` の `SetEnv` など）でも同じキーを上書きできます:
`ZEKEY_DB_PATH` / `ZEKEY_MAX_VAULT_BYTES` / `ZEKEY_TRUST_PROXY` / `ZEKEY_TRUST_PROXY_HOPS` /
`ZEKEY_TRUST_PROXY_IPS`（カンマ区切り）/
`ZEKEY_HTTPS` / `ZEKEY_CORS_ORIGIN` / `ZEKEY_RATE_LIMIT` / `ZEKEY_RATE_LIMIT_CREATE_MAX` /
`ZEKEY_RATE_LIMIT_CREATE_WINDOW` / `ZEKEY_DEBUG` / `ZEKEY_CONFIG` /
`ZEKEY_APP_DIR`（`app/` を公開ディレクトリ外へ移した場合）。

新規ボルトの作成は、`PUT 20/分` とは別に **既定 10 回/時（IP 単位）** のバケットで制限されます。
未認証でも作れる以上、制限がないと 1 つの IP から総量上限（`max_vault_bytes`）まで埋められ、
全員の書き込みが `507` になるためです。上限超過は `429` + `Retry-After`（本文の `scope` は `vault_create`）。
自分でボルトを作り直すことが多い場合は `rate_limit_create_max` を上げてください。
`trust_proxy` が `false`（既定）で Nginx が前段にいる構成では、接続元が Nginx（`127.0.0.1`）に見えて
この上限が「サイト全体で 10 回/時」になることがあります。利用者ごとに数えたい場合は `trust_proxy` と
`trust_proxy_hops` を実構成に合わせて設定してください。

### 3.1 旧 `/aegis/` からの移行

- **DB**: 旧 `/aegis/` の DB は既定で `DOCUMENT_ROOT` の親の `aegis-data/aegis.db` にあります。
  `zekey-data/zekey.db` がまだ無いときにそれを見つけると、`VACUUM INTO` で一貫した
  スナップショット（WAL の未チェックポイント分も含む）を作ってから新しい DB を使います。
  コピーできない環境（権限なしなど）では、印（`zekey-data/.legacy-fallback`）を置いて
  **以後の要求も含めて全部旧 DB を使います**（ある要求は旧 DB、別の要求は新 DB へ書くと、
  片方の更新が見えなくなるため）。権限を直したあと、この印を消すと次のアクセスで移行を再試行します。
  権限の変更や印の削除は、**アクセスが無い時間帯（メンテナンス中）に行ってください**：
  `zekey-data/` に書けない間に旧 DB で動いている要求があると、その後移行が走ったときに
  その要求の書き込みだけが旧 DB に残ります（消えるわけではありませんが、新 DB からは見えません）。
- **旧 DB の削除は、移行が成功して新しい DB で動いていることを確かめてから**にしてください。
  印がある（＝旧 DB を使っている）間は削除しないでください。旧 `aegis` ディレクトリを消すだけなら
  DB には影響しません（DB は `public_html` の外にあります）。
- **リダイレクト**: 旧 `public_html/aegis/.htaccess` を `deploy/xserver/aegis-redirect.htaccess`
  （同じ内容を `downloads/aegis-2fa-deploy/aegis-redirect.htaccess` にも置いてあります）
  の内容に差し替えると、`/aegis/...` へのアクセスを `https://yuushi0911.xsrv.jp/zekey/` へ 301 します
  （ブックマーク・検索結果・共有リンクの行き先を保つため）。旧フォルダのファイルはそのままでも
  かまいません（全リクエストがリダイレクトされます）。
- **端末側**: アプリ名と Android のアプリ ID が変わります。Android は別アプリとして入るので、
  「アプリでログイン」か同期コードでボルトを引き継いでください（暗号形式は同じなのでそのまま開けます）。

## 4. 権限

- `zekey-data/`（`db_path` を `storage/` にする場合は `storage/`）: PHP（FPM の実行ユーザー）が読み書きできること。目安 `0700`。
- アップロードしたファイル: `644`、ディレクトリ: `755`。
- DB ファイルは作成時に `0600` にします（`-wal` / `-shm` も同じディレクトリに出ます）。

## 5. 初回の確認

1. サーバーパネルで PHP を 8.3 系にする（`pdo_sqlite` は標準で有効）。
2. SSL を有効化してから常時 SSL リダイレクトを設定する（SSL 反映前にリダイレクトすると
   `*.xserver.jp` の証明書不一致で「無効な URL」になります）。
   パネルの「常時 SSL」を ON にしなくても、`.htaccess` が HTTP を HTTPS へ 301 リダイレクトします
   （`X-Forwarded-Proto: https` も見るので、Nginx が TLS を終端する Xserver でも無限リダイレクトになりません）。
   ただしパネルで SSL が有効になっていない状態でアクセスすると証明書不一致になるので、**SSL の反映後に**確認します。
3. API の疎通:

```bash
curl -fsS https://<ドメイン>/zekey/api/health
# {"status":"ok","uptime":0,"version":"1.0.0","database":"ok"}

curl -sI https://<ドメイン>/zekey/api/health | grep -i -E 'content-security-policy|cache-control|strict-transport'
curl -sI https://<ドメイン>/zekey/ | grep -i content-security-policy

# HTTP は HTTPS へ 301（Location が https:// で始まる）
curl -sI http://<ドメイン>/zekey/ | grep -i -E '^HTTP|^location'
```

4. ブラウザで `https://<ドメイン>/zekey/` を開き、マスターパスワードを決めてボルトを作成。
   「同期する」を選ぶと同期コードが表示されます。
5. 2 台目の端末で同じ URL を開き、「同期コードで接続」からコードを入力して同じアカウントが見えること。
6. `app/` と `storage/` が外から見えないこと:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<ドメイン>/zekey/app/config.php   # 403
curl -s -o /dev/null -w '%{http_code}\n' https://<ドメイン>/zekey/storage/          # 403
curl -s -o /dev/null -w '%{http_code}\n' https://<ドメイン>/zekey/api/nope           # 404（JSON）
```

## 6. 更新

```bash
pnpm build:xserver
# 変更された index.html / assets/ / sw.js / manifest.webmanifest と、
# PHP を変えた場合は api/ と app/ をアップロードする
```

- `assets/` は内容ハッシュ付きなので、古いファイルが残っていても害はありません（削除して構いません）。
- DB と設定（`zekey-config.php` / `zekey-data/`）は触りません。
- スキーマは初回アクセス時に `CREATE TABLE IF NOT EXISTS` で用意されます（Node 版の DB をそのまま使えます）。
- Xserver の Nginx は静的ファイルを 7 日キャッシュすることがあります。`index.html` と `sw.js` は
  `Cache-Control: no-store` を返しますが、反映が見えないときは `?v=2` を付けて確認してください。

## 7. 実装メモ（Node 版との対応）

| 項目 | Node 版 | PHP 版 |
| --- | --- | --- |
| ルーティング | Hono | `api/index.php` + `.htaccess`（`/api/*` → PHP、他は `index.html`） |
| HTTP→HTTPS | 前段（リバースプロキシ）の責務 | `.htaccess` で 301（`X-Forwarded-Proto` も見る） |
| DB | better-sqlite3 + Drizzle | PDO (`pdo_sqlite`)。スキーマは同一 |
| 認可 | `vaultId = sha256(token)[0:32]` + `token_hash` 一致（`hash_equals` 相当） | 同じ。不一致はすべて 404 |
| 楽観ロック | `revision` 照合、`409 {currentRevision}` | 同じ。書き込みは `BEGIN IMMEDIATE` で直列化 |
| レート制限 | プロセス内 Map | `rate_limits` テーブル（IP 単位、固定ウィンドウ）。新規作成は別バケット |
| body 上限 | 256 KiB（ストリームを読みながら検査） | `php://input` を上限付きで読む + `Content-Length` 検査 |
| 保存上限 | 暗号文の総バイト数、超過は 507 | 同じ（`length(cast(envelope as blob))`） |
| 破損行 | `409 corrupt_vault` | 同じ |
| セキュリティヘッダ | `server/middleware/security.ts` | `app/src/Security.php` + `.htaccess`（ビルド時に一致を検査）。`X-Powered-By` は `bootstrap.php` でも消す |
| health の `uptime` | `process.uptime()` | PHP には常駐プロセスがないため「DB を最初に作った時刻からの経過秒数」 |

`vaultId` / `tokenHash` / 封筒の検証（zod 相当）は Node 版と同じ規則です。
`Validation.php` は Node の zod スキーマと 45 ケースで出力（issues の path と正規化後の封筒）が一致することを確認しています。

## 8. テスト

```bash
pnpm build:xserver           # 先に配信物を組み立てる
pnpm test:xserver            # /zekey/ 配置として全テスト
ZEKEY_BASE=/ pnpm test:xserver   # ルート配置として全テスト
PHP_BIN=/path/to/php pnpm test:xserver
```

`php -S` 上で 6 つのサーバー（機能・レート制限 4 種・保存上限）を起動し、HTTP で検証します
（合計 161 アサーション。設定の解決と `.htaccess` の静的検査は HTTP を介さずに検証します）。

| スイート | 内容 |
| --- | --- |
| `config.php` | DB の置き場所（公開領域外が既定）、外に書けないときは止まること、公開領域外の `zekey-config.php`、相対 `db_path` の警告、環境変数の上書きと丸め |
| `htaccess.php` | HTTP→HTTPS の 301 ルール、遮断する拡張子（`db-journal`・`bak`・`.php[.~]` 等）、HSTS、配信物（`build/zekey`）とソース（`site/`）の一致 |
| `api-compat.php` | health / 静的配信 / SPA フォールバック / 403、PUT・GET・meta・DELETE、409、404 秘匿、400 系（id・JSON・必須・負値・未知キー・revision）、413（Content-Length あり/なし）、409 corrupt_vault、トークンが DB に残らないこと、セキュリティヘッダ |
| `rate-limit.php` | 60/分で 429 + `Retry-After`、`X-Forwarded-For` の偽装では回避できない、`TRUST_PROXY=true` では転送ヘッダ単位、PUT は 20/分、新規作成は別バケット（既存の更新は妨げない） |
| `storage-limit.php` | 総量超過の新規作成・更新が 507、縮小は通る |

Apache 固有の `.htaccess` の挙動は `php -S` では再現できないため、`tests/router.php` が同じ規則
（`/api/*` → PHP、実ファイル、SPA フォールバック、`app/`・`storage/` の 403）で代行します。
**実機（Apache）での初回アップロード時は §5 のチェックリストを必ず実行してください。**

## 9. トラブルシューティング

| 症状 | 原因の候補 | 対処 |
| --- | --- | --- |
| `/zekey/api/health` が 404 で HTML が返る | `.htaccess` の `RewriteRule` が効いていない | `AllowOverride` と `mod_rewrite` を確認。サブディレクトリ名と `--base` の不一致、`RewriteBase` の要否を確認 |
| API が全部 404（JSON） | `Authorization` ヘッダが PHP に届いていない（PHP-FPM/CGI で落ちる） | `.htaccess` の `SetEnvIf Authorization ...` と `[E=HTTP_AUTHORIZATION:...]` を確認 |
| 500（`internal_error`） | PHP のバージョン / `pdo_sqlite` 無効 / `app/` の場所 | パネルで PHP 8.3 を選択。`ZEKEY_APP_DIR` を確認。`debug` を一時的に `true` にして本文を見る（終わったら戻す） |
| health が `503 degraded`、または 500（`error_log` に「データベースの保存先を確保できません」） | DB に書けない | `zekey-data/` の権限と所有者を確認。作れない環境では `zekey-config.php` の `db_path` に書ける場所を指定する |
| 507 | 保存量の上限 | `max_vault_bytes` を上げる（ディスク容量に注意） |
| 429 | レート制限 | `Retry-After` 秒待つ。自分しか使わないなら `rate_limit_*` を調整。新規作成だけ `scope: vault_create` で別枠（既定 10/時） |
| HTTP から HTTPS に転送されない | `.htaccess` が効かない（`AllowOverride`）／`mod_rewrite` 無効 | パネルの「常時 SSL」を ON にする |
| リダイレクトがループする（`ERR_TOO_MANY_REDIRECTS`） | 前段が `X-Forwarded-Proto` を渡さず、Apache の `%{HTTPS}` も `off` になっている | `.htaccess` の HTTPS 強制のブロックを外し、パネルの「常時 SSL」だけで運用する |
| 更新が反映されない | Xserver の Nginx キャッシュ（7 日） | `?v=2` を付けて確認。`assets/` はハッシュ名なので影響なし |
| 常時 SSL で「無効な URL」 | SSL 反映前にリダイレクトした | パネルで SSL を有効化してからリダイレクトを設定 |

## 10. セキュリティとバックアップ

- サーバーが持つのは暗号文・`vaultId`・`token_hash`（SHA-256）・版・時刻だけです。復号鍵もトークン本体も保存しません。
- バックアップは 2 層で:
  1. アプリの「設定 → エクスポート → 暗号化バックアップ」（推奨。中身は暗号文）
  2. DB ファイルの複製。WAL を使っているため、**`cp` は使わないでください**（`-wal` / `-shm` を一緒にコピーしても、
     コピー中に進む更新で時点が混ざります。接続を止めた後でも、未チェックポイントの WAL が残っていると
     確定済みの更新が欠けます）。SQLite のバックアップ API を使ってください。

     ```bash
     umask 077                                              # 0644 で作らない（他ユーザーに読ませない）
     mkdir -p ~/zekey-backups && chmod 700 ~/zekey-backups   # 共有の /tmp には置かない
     # sqlite3 CLI がある場合
     sqlite3 /path/to/zekey.db ".backup '$HOME/zekey-backups/zekey-$(date +%F-%H%M%S).db'"
     # CLI が無い場合（Xserver でも PHP はある）
     php -r '$p = new PDO("sqlite:" . $argv[1]); $p->exec("VACUUM INTO " . $p->quote($argv[2]));' \
       /path/to/zekey.db "$HOME/zekey-backups/zekey-$(date +%F-%H%M%S).db"
     ```

     どちらも稼働中に実行でき、作られるファイルは 0600（`umask 077`）です。
     どうしても `cp` する場合は、全 DB 接続を止め（例: Apache のアクセスを止める、`storage/` を使っているなら
     サイトをメンテナンス状態にする）、DB 本体と残っている `-wal` を同じ時点でコピーしてください。
- アクセスログにはパスのみが残り、`Authorization` ヘッダや本文は記録しません（PHP 側のログも同じ方針）。

## 11. 既知の違い・制約

- `uptime` は「DB を最初に作った時刻からの経過秒数」です（PHP に常駐プロセスがないため）。
- `X-Real-IP` は読みません（Node 版と同じ。`X-Forwarded-For` のみ、`trust_proxy` のときだけ）。
- `trust_proxy=true` でも、転送ヘッダを採用するのは接続元が `trust_proxy_ips`（既定 `127.0.0.1` / `::1`、
  同じホストの前段プロキシ）のときだけです。別ホストのプロキシを使う構成では、その IP を
  `trust_proxy_ips` に追加してください。追加しない場合、直接アクセスするクライアントが
  `X-Forwarded-For` を毎回変えてもレート制限は `REMOTE_ADDR` 単位になり、回避できません。
- 新規ボルトの作成上限（既定 10/時/IP）は PHP 版だけの追加です（Node 版は PUT 20/分のみ）。
- `db_path` に相対パスを書くと、これまでどおりサイト直下（公開領域内）に DB を作りますが、
  その場合 `error_log` に警告を出します（動きは変えていません）。絶対パスを推奨します。
- サーバー間で共有するレート制限は SQLite の 1 ファイルで賄うため、アクセスが集中する用途には向きません（個人〜小規模向け）。
- この環境での動作確認は PHP 8.4 のビルトインサーバーです。Xserver 実機（PHP 8.3.36 / Apache）での
  最終確認は §5 のチェックリストで行ってください。
