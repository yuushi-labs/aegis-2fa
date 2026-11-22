<?php
/**
 * 既定設定。
 *
 * 上書きは次の順で行う（後のものが優先）。
 *   1. 公開ディレクトリ外の zekey-config.php（ZEKEY_CONFIG で場所を指定できる）
 *   2. storage/config.local.php（サイト内で済ませたい場合。.htaccess で 403 保護）
 *   3. 環境変数 ZEKEY_*（Xserver では .htaccess の SetEnv で設定する）
 *
 * どれも設定しなければ、Xserver 上でも安全な既定値で動く。
 */

declare(strict_types=1);

return [
    // SQLite ファイル。
    // null にすると「公開ディレクトリの外（DOCUMENT_ROOT の親）/zekey-data/zekey.db」を使う。
    // そこへ書けない場合は起動時にエラーになるので、db_path を明示する。
    // 旧 /aegis/ の DB（同じ親の aegis-data/aegis.db）が残っていて、まだ zekey-data/zekey.db が
    // 無い場合は、初回アクセス時に中身を写してから新しい場所を使う（写せなければ旧 DB を使う）。
    // 公開領域内を指定する場合（storage/ など）は、Nginx が静的ファイルを直接配信する構成では
    // .htaccess の 403 が効かないことに注意する（README 参照）。絶対パスで書く。
    'db_path' => null,
    // 保存できる暗号文の総量（バイト）。超過する書き込みは 507。
    'max_vault_bytes' => 268435456,
    // CORS を許可するオリジン。null なら同一オリジンのみ（通常はこのまま）。
    'cors_origin' => null,
    // 前段プロキシが X-Forwarded-For を設定・上書きする場合のみ true。
    'trust_proxy' => false,
    'trust_proxy_hops' => 1,
    // 転送ヘッダを信じてよい接続元（プロキシ）の IP。ここに無い接続元は remoteAddr で数える。
    'trust_proxy_ips' => ['127.0.0.1', '::1'],
    // HSTS。null なら HTTPS を自動判定する（Xserver の SSL なら自動で有効）。
    'https' => null,
    // レート制限（/api/vault/* は 60 回/分、PUT は 20 回/分）。
    'rate_limit' => true,
    'rate_limit_read_max' => 60,
    'rate_limit_write_max' => 20,
    'rate_limit_window_seconds' => 60,
    // 新規ボルトの作成だけの別バケット（未認証で無制限に作れると、総量上限まで
    // 埋められて全員の書き込みが 507 になるため）。既存ボルトの同期更新は数えない。
    'rate_limit_create_max' => 10,
    'rate_limit_create_window_seconds' => 3600,
    // 500 の本文に例外メッセージを含めるか。本番では false のまま。
    'debug' => false,
];
