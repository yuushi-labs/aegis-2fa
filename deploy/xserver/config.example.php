<?php
/**
 * 設定ファイルの例。公開ディレクトリの 1 つ上に aegis-config.php という名前で置くと読み込まれる。
 * 例: /home/<サーバーID>/<ドメイン>/aegis-config.php
 *
 * 置き場所を変えたい場合は .htaccess などで AEGIS_CONFIG に絶対パスを設定する。
 * このファイルは配信物に含めない（deploy/xserver/config.example.php はアップロードしない）。
 */

declare(strict_types=1);

return [
    // SQLite の DB。公開ディレクトリの外を指定する（最も安全）。
    'db_path' => '/home/<サーバーID>/aegis-data/aegis.db',

    // 保存できる暗号文の総量（バイト）。超過する書き込みは 507。
    'max_vault_bytes' => 268435456,

    // 前段プロキシが X-Forwarded-For を設定・上書きする場合だけ true。
    // Xserver の共用サーバーでは通常 false のままでよい（REMOTE_ADDR が実クライアント）。
    'trust_proxy' => false,
    'trust_proxy_hops' => 1,

    // レート制限。新規ボルトの作成だけは別枠（既定 10 回/時）。
    'rate_limit' => true,
    // 'rate_limit_create_max' => 10,
    // 'rate_limit_create_window_seconds' => 3600,

    // HSTS。null で HTTPS を自動判定（Xserver の SSL なら自動で有効）。
    'https' => null,

    // 別オリジンから API を使う場合だけ（通常は null）。
    'cors_origin' => null,

    // 500 の本文に例外メッセージを含めるか。本番では false。
    'debug' => false,
];
