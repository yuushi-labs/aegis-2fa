# デプロイ

Aegis 2FA は **静的 SPA + 単一 Node プロセス + SQLite ファイル** で動きます。
外部サービス（DB、Redis、CDN）への依存はありません。

## 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `PORT` | `3000` | 待ち受けポート |
| `DATABASE_PATH` | `./data/aegis.db` | SQLite ファイル。親ディレクトリは自動作成 |
| `TRUST_PROXY` | `false` | `true` で `X-Forwarded-For` を信頼（リバースプロキシ配下で必須） |
| `TRUST_PROXY_HOPS` | `1` | 信頼するプロキシの段数。`X-Forwarded-For` を**右端から**数えた位置をクライアント IP とみなす（CDN + LB のように 2 段なら `2`） |
| `MAX_VAULT_BYTES` | `268435456`（256 MiB） | 保存できる暗号文の総量。超過する書き込みは `507`（`/data` の枯渇防止） |
| `AEGIS_HTTPS` | `false` | `true` で HSTS を付与（TLS 終端が前段にある場合に有効化） |
| `CORS_ORIGIN` | 未設定 | 別オリジンから API を使う場合のみ。通常は未設定のまま |

秘密情報の環境変数はありません。サーバーは復号鍵を一切持たないためです。

## Docker Compose（最短）

```bash
docker compose up --build -d
curl -fsS http://localhost:3000/api/health
```

`docker-compose.yml` は以下を設定済みです。

- 非 root ユーザー（uid 1001）で実行
- `read_only: true` + `/tmp` のみ tmpfs
- `no-new-privileges`
- 名前付きボリューム `aegis-data` を `/data` にマウント
- ヘルスチェック（30 秒間隔）

ボリュームは `docker compose down` では消えません。完全削除は `docker compose down -v`。

## Fly.io

```bash
fly launch --no-deploy
fly volumes create aegis_data --size 1 --region nrt
fly secrets set AEGIS_HTTPS=true TRUST_PROXY=true
fly deploy
```

`fly.toml` の `[mounts]` で `/data` にボリュームを割り当て、`DATABASE_PATH=/data/aegis.db` を
設定してください。`internal_port = 3000`、ヘルスチェックは `GET /api/health`。

## Render

1. New → Web Service → このリポジトリを接続（Dockerfile を自動検出）
2. Disk を追加: mount path `/data`、1 GB
3. 環境変数: `DATABASE_PATH=/data/aegis.db`, `AEGIS_HTTPS=true`, `TRUST_PROXY=true`
4. Health Check Path: `/api/health`

Render の無料プランはディスクを持てないため、永続化には Starter 以上が必要です。

## VPS + Caddy

```caddyfile
aegis.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Forwarded-For {remote_host}
    }
}
```

```bash
# systemd
sudo tee /etc/systemd/system/aegis.service >/dev/null <<'EOF'
[Unit]
Description=Aegis 2FA
After=network.target

[Service]
Type=simple
User=aegis
# /var/lib/aegis を systemd に作らせる（ReadWritePaths はディレクトリを作らない）。
StateDirectory=aegis
StateDirectoryMode=0700
WorkingDirectory=/opt/aegis
Environment=PORT=3000
Environment=DATABASE_PATH=/var/lib/aegis/aegis.db
Environment=TRUST_PROXY=true
Environment=AEGIS_HTTPS=true
ExecStart=/usr/bin/node dist-server/index.js
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/aegis

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now aegis
```

Caddy が TLS を終端するので、アプリ側は HTTP のままで構いません。
`AEGIS_HTTPS=true` を設定すると HSTS ヘッダが付きます。

## バックアップ

2 層で考えてください。

1. **暗号化バックアップ（推奨）**: アプリの「設定 → エクスポート → 暗号化バックアップ」で
   `.aegis` ファイルを保存。中身は暗号文なので、クラウドストレージに置いても安全です。
   復元にはマスターパスワードが必要です。
2. **DB ファイルのスナップショット**: SQLite は WAL を使わない設定なので、
   サービス停止中のコピーで整合します。

```bash
sudo systemctl stop aegis
sudo cp /var/lib/aegis/aegis.db /var/backups/aegis-$(date +%F).db
sudo systemctl start aegis
```

DB には暗号文しかありませんが、同期トークンのハッシュが含まれるため、
ファイル自体もアクセス制御下に置いてください。

## アップデート

```bash
git pull
pnpm install --frozen-lockfile
pnpm build
sudo systemctl restart aegis
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
