<?php
/**
 * 配信物の静的検査（サーバー不要）。
 *
 * php -S では Apache の `.htaccess` の挙動を再現できないので、ここでは
 * ルールが実際に書かれていることと、配信物（build/aegis）がソース（site/）と
 * ずれていないことを確かめる。
 */

declare(strict_types=1);

require __DIR__ . '/lib.php';

$client = new TestClient('http://127.0.0.1:1', '');
$siteRoot = test_site_root();
$sourceRoot = dirname(__DIR__) . '/site';
$htaccess = is_file($siteRoot . '/.htaccess') ? (string) file_get_contents($siteRoot . '/.htaccess') : '';

$client->section('.htaccess（配信物）');

$client->check('.htaccess が存在する', $htaccess !== '', $siteRoot . '/.htaccess');
$client->check(
    'HTTP → HTTPS の 301 リダイレクトがある',
    preg_match('/RewriteRule \^ https:\/\/%\{HTTP_HOST\}%\{REQUEST_URI\} \[R=301,L\]/', $htaccess) === 1,
);
$client->check('HTTPS 判定の条件がある（%{HTTPS}）', str_contains($htaccess, 'RewriteCond %{HTTPS} !=on'));
$client->check(
    'Nginx 終端向けに X-Forwarded-Proto も見る',
    preg_match('/RewriteCond %\{HTTP:X-Forwarded-Proto\} !https \[NC\]/', $htaccess) === 1,
);

$filesMatchPatterns = [];
if (preg_match_all('/<FilesMatch "([^"]+)">/', $htaccess, $matches) === false) {
    $filesMatchPatterns = [];
} else {
    $filesMatchPatterns = $matches[1];
}
$denyPattern = null;
foreach ($filesMatchPatterns as $pattern) {
    if (str_contains($pattern, 'db-wal')) {
        $denyPattern = $pattern;
        break;
    }
}
$client->check('DB・ログ系の FilesMatch がある', $denyPattern !== null);
foreach (['db', 'db-wal', 'db-shm', 'db-journal', 'sqlite', 'sqlite3', 'sql', 'log', 'ini', 'md', 'lock'] as $extension) {
    $client->check(
        '遮断対象に .' . $extension,
        $denyPattern !== null && preg_match('/(^|[|(])' . preg_quote($extension, '/') . '([|)$])/', $denyPattern) === 1,
        (string) $denyPattern,
    );
}
foreach (['bak', 'old', 'orig', 'save', 'swp', 'tmp', 'dist'] as $extension) {
    $client->check(
        '遮断対象に .' . $extension . '（バックアップ・一時ファイル）',
        $denyPattern !== null && preg_match('/(^|[|])' . $extension . '([|)$])/', $denyPattern) === 1,
        (string) $denyPattern,
    );
}
$client->check(
    'config.php.bak / .php~ を遮断する（\\.php[.~]）',
    in_array('\\.php[.~]', $filesMatchPatterns, true),
    implode(' / ', $filesMatchPatterns),
);
$client->check('ドットファイルの遮断（^\\.）が残っている', in_array('^\\.', $filesMatchPatterns, true));
$client->check('FilesMatch は両方の authz 分岐にある', count($filesMatchPatterns) >= 6, (string) count($filesMatchPatterns));
$client->check('HSTS がある', str_contains($htaccess, 'Strict-Transport-Security'));
$client->check('X-Powered-By を消している', str_contains($htaccess, 'Header unset X-Powered-By'));

$client->section('配信物とソースの一致（build/aegis = site/）');

if (realpath($siteRoot) === realpath($sourceRoot)) {
    $client->check('source と同一（比較を省略）', true);
} else {
    $client->check(
        '.htaccess がソースと一致',
        $htaccess === (string) @file_get_contents($sourceRoot . '/.htaccess'),
    );
    $files = [
        'app/config.php',
        'app/bootstrap.php',
        'app/schema.sql',
        'app/.htaccess',
        'api/index.php',
        'storage/.htaccess',
    ];
    foreach (glob($sourceRoot . '/app/src/*.php') ?: [] as $source) {
        $files[] = 'app/src/' . basename($source);
    }
    foreach ($files as $relative) {
        $client->check(
            $relative . ' がソースと一致',
            (string) @file_get_contents($siteRoot . '/' . $relative) === (string) @file_get_contents($sourceRoot . '/' . $relative),
        );
    }
    $client->check(
        'app/version.php が配信物にある（ビルド生成）',
        preg_match("/return '[0-9][^']*';/", (string) @file_get_contents($siteRoot . '/app/version.php')) === 1,
        (string) @file_get_contents($siteRoot . '/app/version.php'),
    );
}

exit($client->summary('htaccess'));
