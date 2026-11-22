<?php
/**
 * 設定の解決（Config）のテスト。HTTP を介さずに、DB の置き場所の決まり方を確かめる。
 *
 * - 既定では公開ディレクトリの外（DOCUMENT_ROOT の親）/zekey-data/ を使う
 * - 公開ディレクトリの外に書けない場合は、公開領域内へフォールバックせずに止まる
 * - 公開ディレクトリの 1 つ上の zekey-config.php が読まれる
 * - 環境変数の上書きと範囲の丸め
 */

declare(strict_types=1);

require __DIR__ . '/lib.php';
require test_site_root() . '/app/src/Config.php';

use Zekey\Config;

$client = new TestClient('http://127.0.0.1:1', '');
$appDir = test_site_root() . '/app';
$appDir = (string) realpath($appDir);
$workRoot = sys_get_temp_dir() . '/zekey-config-' . bin2hex(random_bytes(4));

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
    '既定は公開ディレクトリの外の zekey-data/',
    str_starts_with($config->dbPath, $rootA . '/zekey-data/'),
    $config->dbPath,
);
$client->check('ファイル名はサイト名 + .db', str_ends_with($config->dbPath, '/zekey.db'), $config->dbPath);
$client->check('ディレクトリを実際に作る', is_dir($rootA . '/zekey-data'));

$client->section('設定: 旧 /aegis/ の DB 引き継ぎ');

/** 旧 DB を作る（WAL に書き込みを残したまま接続を開いておく）。 */
$makeLegacyDb = static function (string $root, string $value): PDO {
    if (!is_dir($root . '/aegis-data')) {
        mkdir($root . '/aegis-data', 0700, true);
    }
    $pdo = new PDO('sqlite:' . $root . '/aegis-data/aegis.db');
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec('PRAGMA journal_mode = WAL');
    // 書き込みを WAL に残したまま（メインの DB ファイルへは書き戻さない）。
    $pdo->exec('PRAGMA wal_autocheckpoint = 0');
    $pdo->exec('CREATE TABLE vaults (vault_id TEXT PRIMARY KEY NOT NULL, envelope TEXT NOT NULL)');
    $statement = $pdo->prepare('INSERT INTO vaults (vault_id, envelope) VALUES (?, ?)');
    $statement->execute(['vault-1', $value]);
    return $pdo;
};

$rootD = $workRoot . '/d';
$makeTree($rootD);
$writer = $makeLegacyDb($rootD, '{"keep":"legacy"}');
$config = Config::load($appDir);
$client->check(
    '旧 DB があれば新しい場所 zekey-data/zekey.db を使う',
    $config->dbPath === $rootD . '/zekey-data/zekey.db',
    $config->dbPath,
);
$migrated = new PDO('sqlite:' . $config->dbPath);
$migrated->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$copied = $migrated->query('SELECT envelope FROM vaults WHERE vault_id = \'vault-1\'')->fetchColumn();
$client->check('旧 DB の中身（WAL の未チェックポイント分も）が写っている', $copied === '{"keep":"legacy"}', (string) $copied);
$migrated = null;
$client->check('旧 DB は削除も上書きもしない', is_file($rootD . '/aegis-data/aegis.db'));
$client->check('新しい DB は 0600', (fileperms($config->dbPath) & 0777) === 0600, decoct(fileperms($config->dbPath) & 0777));
$client->check('半端な移行ファイルを残さない', glob($rootD . '/zekey-data/*.migrating-*') === []);

// 両方あるときは新しい DB を優先する（旧 DB で上書きしない）。
$writer->exec('UPDATE vaults SET envelope = \'{"keep":"legacy-updated"}\'');
$writer = null;
$config = Config::load($appDir);
$migrated = new PDO('sqlite:' . $config->dbPath);
$kept = $migrated->query('SELECT envelope FROM vaults WHERE vault_id = \'vault-1\'')->fetchColumn();
$migrated = null;
$client->check('両方あるときは既存の新しい DB をそのまま使う', $kept === '{"keep":"legacy"}', (string) $kept);

// 新しい場所を作れないときは、触らずに旧 DB を使う。
$rootE = $workRoot . '/e';
$makeTree($rootE);
$writer = $makeLegacyDb($rootE, '{"keep":"fallback"}');
$writer = null;
file_put_contents($rootE . '/zekey-data', 'dir を作れない状況を再現する');
$config = Config::load($appDir);
$client->check(
    '写せないときは旧 DB にフォールバックする',
    $config->dbPath === $rootE . '/aegis-data/aegis.db',
    $config->dbPath,
);
unlink($rootE . '/zekey-data');
$client->check('フォールバックしても旧 DB を消さない', is_file($rootE . '/aegis-data/aegis.db'));

// 移行に失敗したら印を置き、以後の要求は（別の要求が移行できても）旧 DB を使い続ける。
// ある要求が旧 DB、別の要求が新しい DB へ書くと、片方の更新が見えなくなるため。
$rootG = $workRoot . '/g';
$makeTree($rootG);
mkdir($rootG . '/aegis-data', 0700, true);
file_put_contents($rootG . '/aegis-data/aegis.db', 'this is not a sqlite database');
$config = Config::load($appDir);
$client->check(
    'スナップショットを作れないときは旧 DB にフォールバックする',
    $config->dbPath === $rootG . '/aegis-data/aegis.db',
    $config->dbPath,
);
$client->check(
    'フォールバックしたことを印として残す',
    is_file($rootG . '/zekey-data/.legacy-fallback'),
);
// 旧 DB を正常なものに差し替えても、印がある間は自動では移行しない。
unlink($rootG . '/aegis-data/aegis.db');
$repaired = $makeLegacyDb($rootG, '{"keep":"repaired"}');
$repaired = null;
$config = Config::load($appDir);
$client->check(
    '印がある間は移行を再試行しない（全要求で旧 DB）',
    $config->dbPath === $rootG . '/aegis-data/aegis.db' && !is_file($rootG . '/zekey-data/zekey.db'),
    $config->dbPath,
);
// 印を消すと移行を再試行する。
unlink($rootG . '/zekey-data/.legacy-fallback');
$config = Config::load($appDir);
$copied = new PDO('sqlite:' . $config->dbPath);
$value = $copied->query('SELECT envelope FROM vaults WHERE vault_id = \'vault-1\'')->fetchColumn();
$copied = null;
$client->check(
    '印を消すと新しい DB へ移行する',
    $config->dbPath === $rootG . '/zekey-data/zekey.db' && $value === '{"keep":"repaired"}',
    $config->dbPath,
);

$rootB = $workRoot . '/b';
$docRootB = $makeTree($rootB);
file_put_contents(
    $rootB . '/zekey-config.php',
    "<?php\nreturn ['db_path' => '" . $rootB . "/custom/zekey.db', 'max_vault_bytes' => 4242];\n",
);
$config = Config::load($appDir);
$client->check('公開ディレクトリの 1 つ上の設定ファイルが読まれる', $config->dbPath === $rootB . '/custom/zekey.db', $config->dbPath);
$client->check('設定ファイルの max_vault_bytes が反映される', $config->maxVaultBytes === 4242, (string) $config->maxVaultBytes);

// 旧名の設定ファイルも読む（カスタム db_path を見失うと、別の DB を開いてボルトが消えたように見える）。
$rootF = $workRoot . '/f';
$makeTree($rootF);
file_put_contents(
    $rootF . '/aegis-config.php',
    "<?php\nreturn ['db_path' => '" . $rootF . "/legacy/custom.db'];\n",
);
$config = Config::load($appDir);
$client->check('旧名の aegis-config.php も読む', $config->dbPath === $rootF . '/legacy/custom.db', $config->dbPath);

// 両方あるときは新しい名前を優先する。
file_put_contents(
    $rootF . '/zekey-config.php',
    "<?php\nreturn ['db_path' => '" . $rootF . "/new/custom.db'];\n",
);
$config = Config::load($appDir);
$client->check('zekey-config.php があればそちらを優先する', $config->dbPath === $rootF . '/new/custom.db', $config->dbPath);
unlink($rootF . '/zekey-config.php');
unlink($rootF . '/aegis-config.php');

unlink($rootB . '/zekey-config.php');
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
$client->check('storage/zekey.db を勝手に使わない', !is_file(dirname($appDir) . '/storage/zekey.db'));

$client->section('設定: 環境変数と丸め');

putenv('ZEKEY_DB_PATH=' . $workRoot . '/env/zekey.db');
putenv('ZEKEY_TRUST_PROXY=true');
putenv('ZEKEY_TRUST_PROXY_HOPS=99');
putenv('ZEKEY_TRUST_PROXY_IPS=10.1.2.3, 192.0.2.4');
putenv('ZEKEY_HTTPS=auto');
putenv('ZEKEY_RATE_LIMIT_WINDOW=30');
putenv('ZEKEY_RATE_LIMIT_CREATE_MAX=3');
putenv('ZEKEY_RATE_LIMIT_CREATE_WINDOW=120');
$config = Config::load($appDir);
$client->check('ZEKEY_DB_PATH が最優先', $config->dbPath === $workRoot . '/env/zekey.db', $config->dbPath);
$client->check('ZEKEY_TRUST_PROXY が true になる', $config->trustProxy === true);
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
putenv('ZEKEY_DB_PATH');
putenv('ZEKEY_TRUST_PROXY');
putenv('ZEKEY_TRUST_PROXY_HOPS');
putenv('ZEKEY_TRUST_PROXY_IPS');
putenv('ZEKEY_HTTPS');
putenv('ZEKEY_RATE_LIMIT_WINDOW');
putenv('ZEKEY_RATE_LIMIT_CREATE_MAX');
putenv('ZEKEY_RATE_LIMIT_CREATE_WINDOW');

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

putenv('ZEKEY_DB_PATH=relative/zekey.db');
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
    $config->dbPath === dirname($appDir) . '/relative/zekey.db',
    $config->dbPath,
);
$warning = is_array($warnings = @file($warningLog)) ? implode('', $warnings) : '';
$client->check('相対 db_path は error_log で警告を出す', str_contains($warning, 'db_path が相対パス'), $warning);
putenv('ZEKEY_DB_PATH');
putenv('ZEKEY_DB_PATH=');
putenv('ZEKEY_TRUST_PROXY');

// 後片付け
foreach (['a', 'b', 'c'] as $name) {
    $path = $workRoot . '/' . $name;
    if (!is_dir($path)) {
        continue;
    }
    chmod($path, 0700);
    @rmdir($path . '/zekey-data');
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
