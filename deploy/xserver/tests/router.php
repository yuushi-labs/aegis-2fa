<?php
/**
 * テスト専用ルーター（php -S 用）。
 *
 * 本番は Apache が site/.htaccess の RewriteRule で同じ振る舞いをする。
 * ここではそれを最小限だけ再現する:
 *   - /api/... → api/index.php（SCRIPT_NAME をサイト基準で設定）
 *   - app/ と storage/、DB・設定・ログ → 403
 *   - 実在するファイル → そのまま返す
 *   - それ以外 → index.html（SPA フォールバック）
 *
 * 使い方:
 *   ZEKEY_SITE_ROOT=/path/to/zekey ZEKEY_BASE=/zekey \
 *     php -S 127.0.0.1:8910 -t /path/to/docroot deploy/xserver/tests/router.php
 */

declare(strict_types=1);

$siteRoot = rtrim((string) (getenv('ZEKEY_SITE_ROOT') ?: dirname(__DIR__, 2) . '/build/zekey'), '/');
$base = rtrim((string) (getenv('ZEKEY_BASE') ?: ''), '/');

$uri = parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
if (!is_string($uri) || $uri === '') {
    $uri = '/';
}

$relative = $uri;
if ($base !== '') {
    if ($uri !== $base && !str_starts_with($uri, $base . '/')) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=UTF-8');
        echo "not found\n";
        return true;
    }
    $relative = substr($uri, strlen($base));
    if ($relative === '') {
        $relative = '/';
    }
}

$deny = static function (): bool {
    http_response_code(403);
    header('Content-Type: text/html; charset=UTF-8');
    echo "<!doctype html><title>403 Forbidden</title><p>403 Forbidden</p>\n";
    return true;
};

// site/.htaccess の Require all denied / FilesMatch 相当
foreach (['/app/', '/storage/'] as $directory) {
    if (str_starts_with($relative, $directory)) {
        return $deny();
    }
}
if (preg_match('/\.(db|db-wal|db-shm|sqlite|sqlite3|sql|log|ini|md|lock)$/i', $relative) === 1) {
    return $deny();
}
if (preg_match('#(^|/)\.#', $relative) === 1) {
    return $deny();
}

// site/.htaccess の RewriteRule ^api(/.*)?$ api/index.php 相当
if ($relative === '/api' || str_starts_with($relative, '/api/')) {
    $_SERVER['SCRIPT_NAME'] = $base . '/api/index.php';
    $_SERVER['SCRIPT_FILENAME'] = $siteRoot . '/api/index.php';
    $_SERVER['PHP_SELF'] = $_SERVER['SCRIPT_NAME'];
    require $siteRoot . '/api/index.php';
    return true;
}

// 実在するファイルはビルトインサーバに任せる（-t の docroot 基準で解決される）。
if ($relative !== '/' && is_file($siteRoot . $relative)) {
    return false;
}

// SPA フォールバック
$index = $siteRoot . '/index.html';
if (!is_file($index)) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=UTF-8');
    echo "index.html が見つかりません\n";
    return true;
}
header('Content-Type: text/html; charset=utf-8');
readfile($index);
return true;
