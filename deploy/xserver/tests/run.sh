#!/usr/bin/env bash
#
# Xserver 用 PHP バックエンドのテスト（php -S 上で実行する）。
#
#   pnpm build:xserver          # 配信物を組み立てる（初回・変更後）
#   pnpm test:xserver           # サブディレクトリ配信（/aegis/）として全部のテストを実行
#   AEGIS_BASE=/ pnpm test:xserver   # ルート配信として実行
#
# 前提: PHP 8.1 以上 + pdo_sqlite（PHP_BIN で実行ファイルを指定できる）。
# Apache 固有の .htaccess の挙動は php -S では再現できないため、
# ルーティング・403・ヘッダの検査は tests/router.php が .htaccess と同じ規則で代行する。

set -u

PHP_BIN="${PHP_BIN:-php}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE="${AEGIS_SITE:-$SCRIPT_DIR/../build/aegis}"
SITE="$(cd "$SITE" 2>/dev/null && pwd || true)"
BASE="${AEGIS_BASE-/aegis}"

if ! command -v "$PHP_BIN" >/dev/null 2>&1; then
  echo "php が見つかりません（PHP_BIN で指定してください）" >&2
  exit 1
fi

if [ -z "$SITE" ] || [ ! -f "$SITE/index.html" ]; then
  echo "配信物がありません。先に pnpm build:xserver を実行してください。" >&2
  exit 1
fi

TMP="$(mktemp -d)"
DOCROOT="$TMP/docroot"
mkdir -p "$DOCROOT"

if [ "$BASE" = "/" ] || [ -z "$BASE" ]; then
  BASE=""
  DOCROOT="$SITE"
else
  BASE="${BASE%/}"
  # リンク名は配信先のパスに合わせる（--base=/foo/ でも静的ファイルが配信できるように）。
  mkdir -p "$(dirname "$DOCROOT$BASE")"
  ln -sfn "$SITE" "$DOCROOT$BASE"
fi

PORT_BASE="${PORT_BASE:-$(( 8900 + ($$ % 90) * 5 ))}"
PIDS=""

cleanup() {
  for pid in $PIDS; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

start_server() { # name port [ENV=value ...]
  local name="$1"
  local port="$2"
  shift 2
  env AEGIS_SITE_ROOT="$SITE" AEGIS_BASE="$BASE" "$@" \
    "$PHP_BIN" -S "127.0.0.1:$port" -t "$DOCROOT" "$SCRIPT_DIR/router.php" \
    >"$TMP/$name.log" 2>&1 &
  PIDS="$PIDS $!"
  local i
  for i in $(seq 1 60); do
    if "$PHP_BIN" -r 'exit(@file_get_contents($argv[1]) === false ? 1 : 0);' \
      "http://127.0.0.1:$port$BASE/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  echo "[$name] サーバーが起動しませんでした。ログ:" >&2
  cat "$TMP/$name.log" >&2
  return 1
}

run_php() { # script [ENV=value ...]
  local script="$1"
  shift
  env AEGIS_TEST_BASE="$BASE" AEGIS_TEST_SITE_ROOT="$SITE" "$@" "$PHP_BIN" "$SCRIPT_DIR/$script"
}

echo "site=$SITE base=${BASE:-/} ports=$PORT_BASE.."
FAILED=0

# 0) 設定の解決と .htaccess の静的検査（サーバー不要）
run_php config.php || FAILED=1
run_php htaccess.php || FAILED=1

# 1) 機能テスト（レート制限だけ無効にしたサーバー）
P1=$PORT_BASE
if start_server functional "$P1" AEGIS_RATE_LIMIT=false AEGIS_DB_PATH="$TMP/functional.db"; then
  run_php api-compat.php \
    AEGIS_TEST_BASE_URL="http://127.0.0.1:$P1" \
    AEGIS_TEST_DB="$TMP/functional.db" || FAILED=1
else
  FAILED=1
fi

# 2) レート制限: 既定（TRUST_PROXY なし）— 転送ヘッダの偽装では回避できない
P2=$(( PORT_BASE + 1 ))
if start_server rate-untrusted "$P2" AEGIS_DB_PATH="$TMP/rate-untrusted.db"; then
  run_php rate-limit.php \
    AEGIS_TEST_BASE_URL="http://127.0.0.1:$P2" \
    AEGIS_TEST_SCENARIO=untrusted || FAILED=1
else
  FAILED=1
fi

# 3) レート制限: TRUST_PROXY=true — 転送ヘッダの値ごとに数える
P3=$(( PORT_BASE + 2 ))
if start_server rate-trusted "$P3" AEGIS_DB_PATH="$TMP/rate-trusted.db" AEGIS_TRUST_PROXY=true; then
  run_php rate-limit.php \
    AEGIS_TEST_BASE_URL="http://127.0.0.1:$P3" \
    AEGIS_TEST_SCENARIO=trusted || FAILED=1
else
  FAILED=1
fi

# 4) レート制限: PUT は 20 req/min
P4=$(( PORT_BASE + 3 ))
if start_server rate-put "$P4" AEGIS_DB_PATH="$TMP/rate-put.db"; then
  run_php rate-limit.php \
    AEGIS_TEST_BASE_URL="http://127.0.0.1:$P4" \
    AEGIS_TEST_SCENARIO=put || FAILED=1
else
  FAILED=1
fi

# 5) レート制限: 新規作成は別の厳しいバケット（上限を 2 に下げて 429 を実際に踏む）
P6=$(( PORT_BASE + 5 ))
if start_server rate-create "$P6" AEGIS_DB_PATH="$TMP/rate-create.db" AEGIS_RATE_LIMIT_CREATE_MAX=2; then
  run_php rate-limit.php \
    AEGIS_TEST_BASE_URL="http://127.0.0.1:$P6" \
    AEGIS_TEST_SCENARIO=create || FAILED=1
else
  FAILED=1
fi

# 6) 保存量の上限（上限を小さくして 507 を実際に踏む）
P5=$(( PORT_BASE + 4 ))
if start_server storage "$P5" AEGIS_DB_PATH="$TMP/storage.db" AEGIS_MAX_VAULT_BYTES=8192; then
  run_php storage-limit.php \
    AEGIS_TEST_BASE_URL="http://127.0.0.1:$P5" \
    AEGIS_TEST_MAX_VAULT_BYTES=8192 || FAILED=1
else
  FAILED=1
fi

if [ "$FAILED" -eq 0 ]; then
  echo
  echo "すべてのテストが通りました（base=${BASE:-/}）"
  exit 0
fi

echo
echo "失敗したテストがあります。サーバーのログ:"
for log in "$TMP"/*.log; do
  [ -f "$log" ] || continue
  echo "--- $log"
  tail -20 "$log"
done
exit 1
