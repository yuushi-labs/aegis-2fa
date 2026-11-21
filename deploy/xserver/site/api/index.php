<?php
/**
 * Xserver（Apache + PHP-FPM）向け API フロントコントローラ。
 *
 * サイト直下の .htaccess が `/api/...` への要求をすべてここへ流し込む。
 * 実際の処理は app/ 以下（.htaccess で 403 保護）に置いてある。
 *
 * app/ を公開ディレクトリの外に置きたい場合は、.htaccess か FPM の環境変数で
 * AEGIS_APP_DIR にその絶対パスを設定する（deploy/xserver/README.md 参照）。
 */

declare(strict_types=1);

$appDir = getenv('AEGIS_APP_DIR');
if (!is_string($appDir) || $appDir === '') {
    $appDir = __DIR__ . '/../app';
}

if (!is_file($appDir . '/bootstrap.php')) {
    http_response_code(500);
    header('Content-Type: application/json; charset=UTF-8');
    echo '{"error":"internal_error","message":"app/bootstrap.php が見つかりません"}';
    return;
}

require $appDir . '/bootstrap.php';
