<?php
/**
 * PHP 版バックエンドの入口。api/index.php から読み込まれる。
 * Composer を使わないので、依存はすべて手動で読み込む（PHP 8.1 以上 + pdo_sqlite のみ）。
 */

declare(strict_types=1);

if (PHP_VERSION_ID < 80100) {
    http_response_code(500);
    header('Content-Type: application/json; charset=UTF-8');
    echo '{"error":"internal_error","message":"PHP 8.1 以上が必要です"}';
    return;
}

if (!extension_loaded('pdo_sqlite')) {
    http_response_code(500);
    header('Content-Type: application/json; charset=UTF-8');
    echo '{"error":"internal_error","message":"pdo_sqlite 拡張が必要です"}';
    return;
}

// 警告が本文に混ざると JSON が壊れるので、画面には出さずログへ回す。
ini_set('display_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);

// PHP のバージョンを応答ヘッダに載せない（.htaccess の Header unset が効かない構成でも防ぐ）。
header_remove('X-Powered-By');

require_once __DIR__ . '/src/Request.php';
require_once __DIR__ . '/src/Response.php';
require_once __DIR__ . '/src/Config.php';
require_once __DIR__ . '/src/Security.php';
require_once __DIR__ . '/src/Database.php';
require_once __DIR__ . '/src/RateLimiter.php';
require_once __DIR__ . '/src/Validation.php';
require_once __DIR__ . '/src/VaultRepository.php';
require_once __DIR__ . '/src/Health.php';
require_once __DIR__ . '/src/Application.php';

\Zekey\Application::run(__DIR__);
