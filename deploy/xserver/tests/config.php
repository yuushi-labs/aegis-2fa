<?php
/**
 * 設定の解決（Config）のテスト。HTTP を介さずに、DB の置き場所の決まり方を確かめる。
 *
 * - 既定では公開ディレクトリの外（DOCUMENT_ROOT の親）/aegis-data/ を使う
 * - 公開ディレクトリの外に書けない場合は、公開領域内へフォールバックせずに止まる
 * - 公開ディレクトリの 1 つ上の aegis-config.php が読まれる
 * - 環境変数の上書きと範囲の丸め
 */

declare(strict_types=1);

require __DIR__ . '/lib.php';
require test_site_root() . '/app/src/Config.php';

use Aegis\Config;

$client = new TestClient('http://127.0.0.1:1', '');
$appDir = test_site_root() . '/app';
$appDir = (string) realpath($appDir);
$workRoot = sys_get_temp_dir() . '/aegis-config-' . bin2hex(random_bytes(4));

/** 公開ディレクトリの親を作り、DOCUMENT_ROOT を設定する。 */
$makeTree = static function (string $root, int $mode = 0700): string {
    $docRoot = $root . '/public_html';
    mkdir($docRoot, 0700, true);
    chmod($root, $mode);
    $_SERVER['DOCUMENT_ROOT'] = $docRoot;
    return $docRoot;
};

$client->section('設定: DB の置き場所');

$rootA = $workRoot . '/a';
$makeTree($rootA);
$config = Config::load($appDir);
$client->check(
    '既定は公開ディレクトリの外の aegis-data/',
    str_starts_with($config->dbPath, $rootA . '/aegis-data/'),
    $config->dbPath,
);
$client->check('ファイル名はサイト名 + .db', str_ends_with($config->dbPath, '/aegis.db'), $config->dbPath);
$client->check('ディレクトリを実際に作る', is_dir($rootA . '/aegis-data'));

$rootB = $workRoot . '/b';
$docRootB = $makeTree($rootB);
file_put_contents(
    $rootB . '/aegis-config.php',
    "<?php\nreturn ['db_path' => '" . $rootB . "/custom/aegis.db', 'max_vault_bytes' => 4242];\n",
);
$config = Config::load($appDir);
$client->check('公開ディレクトリの 1 つ上の設定ファイルが読まれる', $config->dbPath === $rootB . '/custom/aegis.db', $config->dbPath);
$client->check('設定ファイルの max_vault_bytes が反映される', $config->maxVaultBytes === 4242, (string) $config->maxVaultBytes);

unlink($rootB . '/aegis-config.php');
$rootC = $workRoot . '/c';
$makeTree($rootC, 0500);
$failed = null;
try {
    Config::load($appDir);
} catch (RuntimeException $error) {
    $failed = $error;
}
chmod($rootC, 0700);
$client->check('外に書けないときは公開領域内へフォールバックせず止まる', $failed !== null);
$client->check(
    'エラーに db_path の指定方法が書かれている',
    $failed !== null && str_contains($failed->getMessage(), 'db_path'),
    $failed?->getMessage() ?? '',
);
$client->check('storage/aegis.db を勝手に使わない', !is_file(dirname($appDir) . '/storage/aegis.db'));

$client->section('設定: 環境変数と丸め');

putenv('AEGIS_DB_PATH=' . $workRoot . '/env/aegis.db');
putenv('AEGIS_TRUST_PROXY=true');
putenv('AEGIS_TRUST_PROXY_HOPS=99');
putenv('AEGIS_TRUST_PROXY_IPS=10.1.2.3, 192.0.2.4');
putenv('AEGIS_HTTPS=auto');
putenv('AEGIS_RATE_LIMIT_WINDOW=30');
putenv('AEGIS_RATE_LIMIT_CREATE_MAX=3');
putenv('AEGIS_RATE_LIMIT_CREATE_WINDOW=120');
$config = Config::load($appDir);
$client->check('AEGIS_DB_PATH が最優先', $config->dbPath === $workRoot . '/env/aegis.db', $config->dbPath);
$client->check('AEGIS_TRUST_PROXY が true になる', $config->trustProxy === true);
$client->check('TRUST_PROXY_HOPS は 10 で頭打ち', $config->trustProxyHops === 10, (string) $config->trustProxyHops);
$client->check(
    'TRUST_PROXY_IPS をカンマ区切りで読む',
    $config->trustProxyIps === ['10.1.2.3', '192.0.2.4'],
    implode(',', $config->trustProxyIps),
);
$client->check(
    'TRUST_PROXY_IPS に無い接続元は信頼しない',
    $config->isTrustedProxy('127.0.0.1') === false && $config->isTrustedProxy('10.1.2.3') === true,
);
$client->check('https=auto は自動判定（null）', $config->https === null);
$client->check('レート制限のウィンドウを変更できる', $config->rateLimitWindowSeconds === 30);
$client->check('新規作成の上限を変更できる', $config->rateLimitCreateMax === 3, (string) $config->rateLimitCreateMax);
$client->check('新規作成のウィンドウを変更できる', $config->rateLimitCreateWindowSeconds === 120, (string) $config->rateLimitCreateWindowSeconds);
putenv('AEGIS_DB_PATH');
putenv('AEGIS_TRUST_PROXY');
putenv('AEGIS_TRUST_PROXY_HOPS');
putenv('AEGIS_TRUST_PROXY_IPS');
putenv('AEGIS_HTTPS');
putenv('AEGIS_RATE_LIMIT_WINDOW');
putenv('AEGIS_RATE_LIMIT_CREATE_MAX');
putenv('AEGIS_RATE_LIMIT_CREATE_WINDOW');

$config = Config::load($appDir);
$client->check(
    'TRUST_PROXY_IPS の既定はループバック',
    $config->trustProxyIps === ['127.0.0.1', '::1'],
    implode(',', $config->trustProxyIps),
);
$client->check('既定ではループバックを信頼する', $config->isTrustedProxy('127.0.0.1') && $config->isTrustedProxy('::1'));
$client->check('既定では外部の接続元を信頼しない', $config->isTrustedProxy('198.51.100.7') === false);
$client->check('新規作成の上限の既定は 10', $config->rateLimitCreateMax === 10, (string) $config->rateLimitCreateMax);
$client->check(
    '新規作成のウィンドウの既定は 3600 秒',
    $config->rateLimitCreateWindowSeconds === 3600,
    (string) $config->rateLimitCreateWindowSeconds,
);

putenv('AEGIS_DB_PATH=relative/aegis.db');
$warningLog = $workRoot . '/config-warning.log';
$previousLog = ini_get('error_log');
$previousLogErrors = ini_get('log_errors');
ini_set('log_errors', '1');
ini_set('error_log', $warningLog);
$config = Config::load($appDir);
ini_set('log_errors', $previousLogErrors === false ? '0' : (string) $previousLogErrors);
ini_set('error_log', $previousLog === false ? '' : (string) $previousLog);
$client->check(
    '相対パスはサイト直下として解決する',
    $config->dbPath === dirname($appDir) . '/relative/aegis.db',
    $config->dbPath,
);
$warning = is_array($warnings = @file($warningLog)) ? implode('', $warnings) : '';
$client->check('相対 db_path は error_log で警告を出す', str_contains($warning, 'db_path が相対パス'), $warning);
putenv('AEGIS_DB_PATH');
putenv('AEGIS_DB_PATH=');
putenv('AEGIS_TRUST_PROXY');

// 後片付け
foreach (['a', 'b', 'c'] as $name) {
    $path = $workRoot . '/' . $name;
    if (!is_dir($path)) {
        continue;
    }
    chmod($path, 0700);
    @rmdir($path . '/aegis-data');
    $entries = glob($path . '/*') ?: [];
    foreach ($entries as $entry) {
        if (is_file($entry)) {
            unlink($entry);
        }
    }
    @rmdir($path . '/public_html');
    @rmdir($path);
}
@rmdir($workRoot);

exit($client->summary('config'));
