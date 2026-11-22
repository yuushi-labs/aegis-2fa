# デプロイ

Zekey 2FA は **静的 SPA + 単一 Node プロセス + SQLite ファイル** で動きます。
外部サービス（DB、Redis、CDN）への依存はありません。

## 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `PORT` | `3000` | 待ち受けポート |
| `DATABASE_PATH` | `./data/zekey.db` | SQLite ファイル。親ディレクトリは自動作成 |
| `TRUST_PROXY` | `false` | `true` で `X-Forwarded-For` を信頼（リバースプロキシ配下で必須）。**`PORT` への直接接続をファイアウォール等で遮断すること**（直接届くとヘッダを偽装できる）。前段は `X-Forwarded-For` を上書きし、`X-Real-IP` は読みません |
| `TRUST_PROXY_HOPS` | `1` | 信頼するプロキシの段数。`X-Forwarded-For` を**右端から**数えた位置をクライアント IP とみなす（CDN + LB のように 2 段なら `2`） |
| | | 多段の場合、最初のプロキシがクライアントの `X-Forwarded-For` を置き換え、後続のプロキシが接続元 IP を履歴へ追加する構成にすること（全利用者が同じキーにまとまって制限を共有しないため） |
| `MAX_VAULT_BYTES` | `268435456`（256 MiB） | 保存できる暗号文の総量。超過する書き込みは `507`（`/data` の枯渇防止） |
| `ZEKEY_HTTPS` | `false` | `true` で HSTS を付与（TLS 終端が前段にある場合に有効化） |
| `CORS_ORIGIN` | 未設定 | 別オリジンから API を使う場合のみ。通常は未設定のまま |

秘密情報の環境変数はありません。サーバーは復号鍵を一切持たないためです。

> 旧名（Aegis 2FA）の Node 版を動かしていた場合、DB の既定名は `./data/aegis.db` でした。
> 既存の DB をそのまま使うには `DATABASE_PATH=/data/aegis.db` のように明示してください
> （Docker の永続ボリューム内のファイルも同様）。何も指定しなければ新しい `zekey.db` が作られます。

PHP 版（Xserver など共用サーバー）は環境変数の代わりに公開ディレクトリ外の
`zekey-config.php` で同じ項目を設定します（[deploy/xserver/README.md](../deploy/xserver/README.md)）。

## Docker Compose（最短）

```bash
docker compose up --build -d
curl -fsS http://localhost:3000/api/health
```

`docker-compose.yml` は以下を設定済みです。

- 非 root ユーザー（uid 1001）で実行
- `read_only: true` + `/tmp` のみ tmpfs
- `no-new-privileges`
- 名前付きボリューム `zekey-data` を `/data` にマウント
- ヘルスチェック（30 秒間隔）

ボリュームは `docker compose down` では消えません。完全削除は `docker compose down -v`。

### 旧 Aegis 2FA（aegis サービス）の Compose 環境からの移行

サービス名とボリューム名が変わったため、**旧コンテナを止めてから**起動しないとホストの 3000 番が競合します。
データは旧ボリューム（Compose のプロジェクト名が頭に付く。例: `zekey-2fa_aegis-data`）に残っています。

```bash
# 1. 旧プロジェクト名を確かめて、そのプロジェクトを停止・削除（ボリュームは残る）
docker compose ls                       # 例: NAME=zekey-2fa（旧名のままなら aegis-2fa など）
docker compose -p <旧プロジェクト名> down --remove-orphans

# 2. 旧ボリューム名を確かめて、新しいボリュームへ中身を写す（既存の DB があるときは何もしない）
docker volume ls | grep -E 'aegis-data|zekey-data'
docker run --rm \
  -v <旧ボリューム名>:/from \
  -v <新ボリューム名>:/to \
  alpine sh -c 'if [ -f /to/zekey.db ] || [ -f /to/aegis.db ]; then echo "コピー先に DB があります。上書きしないため中止しました。中身を確認してください" >&2; exit 1; fi; cp -a /from/. /to/'

# 3. 起動
docker compose up --build -d
```

コピー先に既に DB がある場合（先に新環境を起動してしまった場合など）は、上のコマンドは上書きせずに止まります。
`docker compose down` で止めて `docker volume inspect` で中身を確認し、必要なら退避（例: `cp -a` で別名に保存）
してから、どちらを使うかを決めてください。

旧 DB のファイル名が `aegis.db` のままなら、`docker-compose.yml` の `DATABASE_PATH` を
`/data/aegis.db` にするか、写したあとで `mv /data/aegis.db /data/zekey.db` に相当する操作をしてください。
旧環境を使っていない（新規インストール）場合は 1〜2 は不要です。

## Fly.io

```bash
fly launch --no-deploy
fly volumes create zekey_data --size 1 --region nrt
fly secrets set ZEKEY_HTTPS=true TRUST_PROXY=true TRUST_PROXY_HOPS=2
fly deploy
```

`fly.toml` の `[mounts]` で `/data` にボリュームを割り当て、`DATABASE_PATH=/data/zekey.db` を
設定してください。`internal_port = 3000`、ヘルスチェックは `GET /api/health`。

`TRUST_PROXY_HOPS` は「アプリの手前にあるプロキシの段数」です。Fly Proxy だけが前段なら `2`
（右端はアプリ側から見たプロキシのアドレスで、その 1 つ前がクライアント IP）。CDN などを
さらに前段に置く場合は段数を増やし、`X-Forwarded-For` の並びを実測して決めてください。

CDN を併用する場合は、**CDN 以外から Fly アプリへ直接届く要求を拒否**する構成にしてください
（`.fly.dev` を公開したままにすると、クライアントが指定した `X-Forwarded-For` がそのまま
レート制限のキーに使われ得ます）。

## Render

1. New → Web Service → このリポジトリを接続（Dockerfile を自動検出）
2. Disk を追加: mount path `/data`、1 GB
3. 環境変数: `DATABASE_PATH=/data/zekey.db`, `ZEKEY_HTTPS=true`, `TRUST_PROXY=true`
4. Health Check Path: `/api/health`

Render の無料プランはディスクを持てないため、永続化には Starter 以上が必要です。

## VPS + Caddy

```caddyfile
zekey.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Forwarded-For {remote_host}
    }
}
```

```bash
# systemd
sudo tee /etc/systemd/system/zekey.service >/dev/null <<'EOF'
[Unit]
Description=Zekey 2FA
After=network.target

[Service]
Type=simple
User=zekey
# /var/lib/zekey を systemd に作らせる（ReadWritePaths はディレクトリを作らない）。
StateDirectory=zekey
StateDirectoryMode=0700
WorkingDirectory=/opt/zekey
Environment=PORT=3000
Environment=DATABASE_PATH=/var/lib/zekey/zekey.db
Environment=TRUST_PROXY=true
Environment=ZEKEY_HTTPS=true
ExecStart=/usr/bin/node dist-server/index.js
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/zekey

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now zekey
```

Caddy が TLS を終端するので、アプリ側は HTTP のままで構いません。
`ZEKEY_HTTPS=true` を設定すると HSTS ヘッダが付きます。

## Xserver（共用サーバー・PHP 8.3 + SQLite）

Node を使えない共用レンタルサーバー向けに、同じ API を PHP で提供する構成を同梱しています。
Composer も Node も不要で、ビルドしたファイルをアップロードするだけで動きます。

```bash
pnpm build:xserver                  # deploy/xserver/build/zekey/ を生成（既定 base=/zekey/）
pnpm build:xserver -- --base=/      # ドメイン直下に置く場合
pnpm test:xserver                   # php -S 上で API 互換テスト
```

- 出力された `deploy/xserver/build/zekey/` の中身を `public_html/zekey/` へアップロード
- `.htaccess` が `/api/*` を PHP へ、それ以外を `index.html`（SPA）へ流す
- DB は公開ディレクトリの外（`zekey-config.php` の `db_path`）を推奨。未設定なら
  `DOCUMENT_ROOT` の親の `zekey-data/` に自動で作り、書けなければ `storage/`（403 保護）へ
- スキーマは Node 版と同一なので、Node 版が作った DB をそのまま使える
- レート制限・保存上限・body 上限・`409 corrupt_vault`・セキュリティヘッダも Node 版と同じ

### 検索エンジン向け（SEO）

ビルド時に `scripts/seo.ts` が `robots.txt` と `sitemap.xml` を出力の直下へ書き出します。
`base`（`/zekey/` など）と公開オリジンから絶対 URL を組み立てるので、手で編集する必要はありません。

- `robots.txt`: 全体を許可し、`Disallow: <base>api/` で API だけを除外 + `Sitemap:` の絶対 URL
- `sitemap.xml`: ホームと `/privacy` の 2 ページ
- **`robots.txt` はオリジン直下でしか読まれない**（RFC 9309）。`/zekey/` に置いた
  `robots.txt` は、同じ内容をドメイン直下の `public_html/robots.txt` にも置いて初めて
  クローラに届く。直下に WordPress などの `robots.txt` がある場合は上書きせず、生成された
  `robots.txt` の `Disallow:` 行（`base` に合わせて自動で入る）を**各 User-agent グループに**
  追記する（末尾にまとめて追記すると直前のグループにしか効かない）。`Sitemap:` 行は
  グループに属しないので 1 行あればよい（サイトマップは Search Console から直接送信してもよい）。
  既存ルールに `Disallow: /` があるとホームと `/privacy` もクロールされないため、その場合は
  アプリの公開ページだけを許可する（`/zekey/` 配置は `Allow: /zekey/`、ルート配置は `Allow: /$` と
  `Allow: /privacy$`。`Allow: /` は全体を許可してしまう）。より限定的な既存ルール（限定的なものが優先）も確認する
- `index.html`: title / description / canonical / OGP / Twitter Card / JSON-LD（`SoftwareApplication`）
  をビルド時に絶対 URL へ解決（`%…%` ではなく `__HOME_URL__` などのプレースホルダ）
- 公開ドメインが既定（`https://yuushi0911.xsrv.jp`）と違うときは、ビルド時に
  `VITE_SITE_ORIGIN=https://example.com` を指定する（パス付きは不可。パスは `--base` で決める）
- `.htaccess` は `.xml` の MIME を明示し、HTML/CSS/JS/JSON/XML/SVG を gzip 圧縮する
  （`mod_deflate` がある環境だけ。`robots.txt` / `sitemap.xml` は遮断対象外）

セットアップ、設定項目、動作確認チェックリスト、トラブルシューティングは
[deploy/xserver/README.md](../deploy/xserver/README.md) にまとめています。

## バックアップ

2 層で考えてください。

1. **暗号化バックアップ（推奨）**: アプリの「設定 → エクスポート → 暗号化バックアップ」で
   `.zekey` ファイルを保存。中身は暗号文なので、クラウドストレージに置いても安全です。
   復元にはマスターパスワードが必要です。
2. **DB ファイルのスナップショット**: SQLite は WAL を使わない設定なので、
   サービス停止中のコピーで整合します。

```bash
sudo systemctl stop zekey
sudo cp /var/lib/zekey/zekey.db /var/backups/zekey-$(date +%F).db
sudo systemctl start zekey
```

DB には暗号文しかありませんが、同期トークンのハッシュが含まれるため、
ファイル自体もアクセス制御下に置いてください。

## アップデート

```bash
git pull
pnpm install --frozen-lockfile
pnpm build
sudo systemctl restart zekey
```

DB マイグレーションは起動時に自動適用されます（`drizzle/` を `dist-server/` に同梱）。
ダウングレードは想定していないため、メジャー更新前に DB をコピーしてください。

## 動作確認チェックリスト

```bash
curl -fsS http://localhost:3000/api/health          # {"status":"ok",...}
curl -sI http://localhost:3000/ | grep -i content-security-policy
curl -sI http://localhost:3000/api/health | grep -i cache-control   # no-store
```

- ブラウザで開き、ボルトを作成できる
- リロードしてもボルトが残る（IndexedDB）
- 同期コードで 2 台目の端末から接続できる
