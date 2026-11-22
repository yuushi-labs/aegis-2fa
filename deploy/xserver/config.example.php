<?php
/**
 * 設定ファイルの例。公開ディレクトリの 1 つ上に zekey-config.php という名前で置くと読み込まれる。
 * 例: /home/<サーバーID>/<ドメイン>/zekey-config.php
 *
 * 置き場所を変えたい場合は .htaccess などで ZEKEY_CONFIG に絶対パスを設定する。
 * 旧名の aegis-config.php / AEGIS_CONFIG も読む（すでにカスタムの db_path を使っている
 * 環境で設定を見失わないため。新しい名前があればそちらを優先）。
 * このファイルは配信物に含めない（deploy/xserver/config.example.php はアップロードしない）。
 */

declare(strict_types=1);

return [
    // SQLite の DB。
    // null のままだと、公開ディレクトリの外（DOCUMENT_ROOT の親）の zekey-data/zekey.db を使う。
    // 旧 /aegis/ の aegis-data/aegis.db が残っていれば、初回アクセス時に中身を写してから使う。
    // **絶対パスを書くとそのパスをそのまま使い、上の自動引き継ぎは行わない**（DB を移したいときだけ指定する）。
    'db_path' => null,

    // 保存できる暗号文の総量（バイト）。超過する書き込みは 507。
    'max_vault_bytes' => 268435456,

    // 前段プロキシが X-Forwarded-For を設定・上書きする場合だけ true。
    // Xserver の共用サーバーでは通常 false のままでよい（REMOTE_ADDR が実クライアント）。
    'trust_proxy' => false,
    'trust_proxy_hops' => 1,
    // X-Forwarded-For を信じてよい接続元の IP（カンマ区切りでも可）。
    // ここに無い接続元からの転送ヘッダは無視し、REMOTE_ADDR で数える。
    // 'trust_proxy_ips' => ['127.0.0.1', '::1'],

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
