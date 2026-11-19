# Aegis 2FA

**ゼロ知識 E2EE 同期対応の Web 2FA Authenticator。** 秘密鍵はブラウザから出ません。サーバーには AES-256-GCM の暗号文だけが置かれます。

> Status: 開発中 — 仕様は [SPEC.md](SPEC.md)、セキュリティモデルは [docs/SECURITY.md](docs/SECURITY.md)。

## 特徴

- **TOTP / HOTP**（RFC 6238 / RFC 4226 準拠、SHA-1/256/512、6/8 桁、任意 period、クロックスキュー補正、次期コード表示）
- **QR 読み取り / 生成**、`otpauth://` URI の入出力、**Google Authenticator 移行 QR** の一括インポート
- **ゼロ知識同期**: PBKDF2(600k) + AES-256-GCM。サーバーは復号鍵を持てない
- **ローカル完結モード**: 同期を使わなければ通信ゼロ
- 自動ロック、クリップボード自動クリア、暗号化バックアップ
- 温かみのある UI、ライト/ダーク、PWA（オフラインでコード生成）

## クイックスタート

```bash
pnpm install
pnpm dev          # http://localhost:5173
```

### Docker

```bash
docker compose up --build   # http://localhost:3000
```

## 構成

```
shared/   純粋ロジック（TOTP/HOTP/Base32/otpauth/migration/crypto）
server/   Hono + SQLite(Drizzle)。暗号文の保存と配信のみ
src/      React 19 + Vite + Tailwind のクライアント
tests/    unit / integration / e2e
```

## デプロイ

[docs/DEPLOY.md](docs/DEPLOY.md) を参照（Docker Compose / Fly.io / Render / VPS + Caddy）。

## セキュリティ

脆弱性の報告は公開 Issue ではなく、リポジトリの Security Advisory から。詳細は [docs/SECURITY.md](docs/SECURITY.md)。

## ライセンス

MIT
