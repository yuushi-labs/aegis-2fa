<?php
/**
 * PHP 版バックエンドの API 互換テスト（レート制限は無効のサーバーに対して実行する）。
 *
 * 前提: AEGIS_TEST_BASE_URL（例 http://127.0.0.1:8910）と AEGIS_TEST_DB（DB のパス）を設定する。
 * Content-Security-Policy などのヘッダは .htaccess の値とも突き合わせる。
 */

declare(strict_types=1);

require __DIR__ . '/lib.php';

$baseUrl = rtrim((string) (getenv('AEGIS_TEST_BASE_URL') ?: 'http://127.0.0.1:8910'), '/');
$basePath = (string) (getenv('AEGIS_TEST_BASE') ?: '');
if ($basePath === '/') {
    $basePath = '';
}
$dbPath = (string) (getenv('AEGIS_TEST_DB') ?: '');
$siteRoot = test_site_root();

$client = new TestClient($baseUrl, $basePath);

// ---------------------------------------------------------------------------
$client->section('GET /api/health');

$health = $client->request('GET', '/api/health');
$body = is_array($health['json']) ? $health['json'] : [];
$client->check('200 を返す', $health['status'] === 200, 'status=' . $health['status']);
$client->check('status=ok', ($body['status'] ?? null) === 'ok');
$client->check('database=ok', ($body['database'] ?? null) === 'ok');
$client->check('uptime が整数', isset($body['uptime']) && is_int($body['uptime']));
// バージョンは package.json からビルド時に app/version.php へ書かれるので、そこを正にする
// （リリースごとに手で直すと、上げ忘れで CI が落ちる）。
preg_match("/return '([^']+)';/", (string) @file_get_contents($siteRoot . '/app/version.php'), $versionMatch);
$expectedVersion = $versionMatch[1] ?? '';
$client->check(
    'version が app/version.php と一致',
    $expectedVersion !== '' && ($body['version'] ?? null) === $expectedVersion,
    (string) ($body['version'] ?? 'null'),
);
$client->check(
    'Content-Type が JSON',
    str_contains((string) ($health['headers']['content-type'] ?? ''), 'application/json'),
);

$htaccess = (string) @file_get_contents($siteRoot . '/.htaccess');
preg_match('/Content-Security-Policy "([^"]+)"/', $htaccess, $cspMatch);
$expectedCsp = $cspMatch[1] ?? '';
$client->check('CSP が .htaccess と一致', ($health['headers']['content-security-policy'] ?? '') === $expectedCsp);
$client->check(
    'CSP が connect-src \'self\' を含む',
    str_contains((string) ($health['headers']['content-security-policy'] ?? ''), "connect-src 'self'"),
);
$client->check('X-Content-Type-Options: nosniff', ($health['headers']['x-content-type-options'] ?? '') === 'nosniff');
$client->check('Referrer-Policy: no-referrer', ($health['headers']['referrer-policy'] ?? '') === 'no-referrer');
$client->check('X-Frame-Options: DENY', ($health['headers']['x-frame-options'] ?? '') === 'DENY');
$client->check(
    'Permissions-Policy が camera/microphone を制限',
    str_contains((string) ($health['headers']['permissions-policy'] ?? ''), 'camera=(self)')
        && str_contains((string) ($health['headers']['permissions-policy'] ?? ''), 'microphone=()'),
);
$client->check('Cross-Origin-Opener-Policy: same-origin', ($health['headers']['cross-origin-opener-policy'] ?? '') === 'same-origin');
$client->check('Cross-Origin-Resource-Policy: same-origin', ($health['headers']['cross-origin-resource-policy'] ?? '') === 'same-origin');
$client->check('Cache-Control: no-store', ($health['headers']['cache-control'] ?? '') === 'no-store');
$client->check('HTTP では HSTS を付けない', !isset($health['headers']['strict-transport-security']));

// ---------------------------------------------------------------------------
$client->section('静的配信と SPA フォールバック');

$root = $client->request('GET', '/');
$client->check('GET / が index.html を返す', $root['status'] === 200 && str_contains($root['body'], '<div id="root">'));

$spa = $client->request('GET', '/accounts');
$client->check('未知のパスは index.html（SPA フォールバック）', $spa['status'] === 200 && str_contains($spa['body'], '<div id="root">'));

// プライバシーポリシー（/privacy）は、ロック解除前でも直リンク・リロードで開ける必要がある。
// 実際のリダイレクトは Apache の .htaccess（php -S では router.php が同じ規則を再現）が行う。
$privacy = $client->request('GET', '/privacy');
$client->check(
    'GET /privacy が index.html を返す（直リンクで開ける）',
    $privacy['status'] === 200 && str_contains((string) $privacy['body'], '<div id="root">'),
    'status=' . $privacy['status'],
);
$client->check(
    'GET /privacy の Content-Type が HTML',
    str_contains((string) ($privacy['headers']['content-type'] ?? ''), 'text/html'),
    (string) ($privacy['headers']['content-type'] ?? ''),
);
$client->check('GET /privacy の本文が / と同じ index.html', $privacy['body'] === $root['body']);

$manifest = $client->request('GET', '/manifest.webmanifest');
$manifestBody = is_array($manifest['json']) ? $manifest['json'] : [];
$client->check('manifest が配信される', $manifest['status'] === 200 && ($manifestBody['name'] ?? null) === 'Aegis 2FA');
$client->check('manifest の start_url が相対パス', ($manifestBody['start_url'] ?? null) === './');

$sw = $client->request('GET', '/sw.js');
$client->check('Service Worker が配信される', $sw['status'] === 200 && str_contains($sw['body'], 'aegis-shell-'));
$client->check(
    'キャッシュ名にビルドのハッシュが入る（アセットが変わればキャッシュを作り直す）',
    preg_match('/CACHE_VERSION = \'v1-[0-9a-f]{8}\'/', (string) $sw['body']) === 1,
);

// 初回のオフライン起動で使うエントリ JS / CSS が install 時のプリキャッシュに入っているか。
preg_match_all('/(?:src|href)="([^"]+\.(?:js|css))"/', (string) $root['body'], $entryMatches);
$entryAssets = [];
foreach ($entryMatches[1] as $entryPath) {
    $entryAssets[] = $basePath === '' ? ltrim($entryPath, '/') : ltrim(substr($entryPath, strlen($basePath)), '/');
}
$client->check('index.html が JS / CSS を参照している', $entryAssets !== [], implode(',', $entryAssets));
foreach ($entryAssets as $entryAsset) {
    $client->check(
        'エントリの ' . $entryAsset . ' が sw.js のプリキャッシュに入る',
        str_contains((string) $sw['body'], '"' . $entryAsset . '"'),
    );
}

$assets = glob($siteRoot . '/assets/*.js') ?: [];
$client->check('assets/ にハッシュ付き JS がある', $assets !== []);
if ($assets !== []) {
    $asset = $client->request('GET', '/assets/' . basename($assets[0]));
    $client->check('assets/ のファイルが配信される', $asset['status'] === 200 && $asset['body'] !== '');
}

$client->check('app/config.php は 403', $client->request('GET', '/app/config.php')['status'] === 403);
$client->check('app/bootstrap.php は 403', $client->request('GET', '/app/bootstrap.php')['status'] === 403);
$client->check('storage/ は 403', $client->request('GET', '/storage/')['status'] === 403);
$client->check('.htaccess は 403', $client->request('GET', '/.htaccess')['status'] === 403);

$client->check('未知の /api/* は JSON 404', (static function () use ($client): bool {
    $response = $client->request('GET', '/api/does-not-exist');
    return $response['status'] === 404 && ($response['json']['error'] ?? null) === 'not_found';
})());

// ---------------------------------------------------------------------------
$client->section('ボルトの作成・取得・更新・競合・削除');

$token = test_token();
$vaultId = test_vault_id($token);
$envelope1 = test_envelope(1);

$create = $client->request(
    'PUT',
    '/api/vault/' . $vaultId,
    ['Authorization' => test_bearer($token), 'Content-Type' => 'application/json'],
    test_put_body($envelope1, 0),
);
$client->check('作成は 200 と新しい revision', $create['status'] === 200 && ($create['json']['revision'] ?? null) === 1, 'status=' . $create['status']);

$get = $client->request('GET', '/api/vault/' . $vaultId, ['Authorization' => test_bearer($token)]);
$client->check('取得は 200', $get['status'] === 200, 'status=' . $get['status']);
$client->check('封筒が一致する', is_array($get['json']) && ($get['json']['envelope'] ?? null) == $envelope1);
$client->check('revision が一致する', is_array($get['json']) && ($get['json']['revision'] ?? null) === 1);

$meta = $client->request('GET', '/api/vault/' . $vaultId . '/meta', ['Authorization' => test_bearer($token)]);
$client->check('meta は revision を返す', $meta['status'] === 200 && ($meta['json']['revision'] ?? null) === 1);
$client->check(
    'meta の updatedAt は ISO 8601（ミリ秒 + Z）',
    is_string($meta['json']['updatedAt'] ?? null)
        && preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/', (string) $meta['json']['updatedAt']) === 1,
    (string) ($meta['json']['updatedAt'] ?? 'null'),
);

$envelope2 = test_envelope(2);
$update = $client->request(
    'PUT',
    '/api/vault/' . $vaultId,
    ['Authorization' => test_bearer($token), 'Content-Type' => 'application/json'],
    test_put_body($envelope2, 1),
);
$client->check('更新は 200 と revision 2', $update['status'] === 200 && ($update['json']['revision'] ?? null) === 2);

$stale = $client->request(
    'PUT',
    '/api/vault/' . $vaultId,
    ['Authorization' => test_bearer($token), 'Content-Type' => 'application/json'],
    test_put_body(test_envelope(3), 1),
);
$client->check('古い revision は 409', $stale['status'] === 409, 'status=' . $stale['status']);
$client->check('409 に currentRevision が入る', ($stale['json']['currentRevision'] ?? null) === 2);

$otherToken = test_token();
$client->check('別トークンの GET は 404', $client->request('GET', '/api/vault/' . $vaultId, ['Authorization' => test_bearer($otherToken)])['status'] === 404);
$client->check('別トークンの meta は 404', $client->request('GET', '/api/vault/' . $vaultId . '/meta', ['Authorization' => test_bearer($otherToken)])['status'] === 404);
$client->check('別トークンの DELETE は 404', $client->request('DELETE', '/api/vault/' . $vaultId, ['Authorization' => test_bearer($otherToken)])['status'] === 404);
$client->check('別トークンの PUT は 404', $client->request(
    'PUT',
    '/api/vault/' . $vaultId,
    ['Authorization' => test_bearer($otherToken), 'Content-Type' => 'application/json'],
    test_put_body(test_envelope(3), 2),
)['status'] === 404);
$client->check('Authorization 無しの GET は 404', $client->request('GET', '/api/vault/' . $vaultId)['status'] === 404);
$client->check('Authorization 無しの meta は 404', $client->request('GET', '/api/vault/' . $vaultId . '/meta')['status'] === 404);
$client->check('Authorization 無しの DELETE は 404', $client->request('DELETE', '/api/vault/' . $vaultId)['status'] === 404);

$missingToken = test_token();
$missingId = test_vault_id($missingToken);
$client->check('存在しないボルトは 404', $client->request('GET', '/api/vault/' . $missingId, ['Authorization' => test_bearer($missingToken)])['status'] === 404);

$client->check('id 形式不正の PUT は 400 invalid_vault_id', (static function () use ($client, $token): bool {
    $response = $client->request(
        'PUT',
        '/api/vault/NOT-A-VALID-ID',
        ['Authorization' => test_bearer($token), 'Content-Type' => 'application/json'],
        test_put_body(test_envelope(1), 0),
    );
    return $response['status'] === 400 && ($response['json']['error'] ?? null) === 'invalid_vault_id';
})());
$client->check('id 形式不正の GET は 404', $client->request('GET', '/api/vault/NOT-A-VALID-ID', ['Authorization' => test_bearer($token)])['status'] === 404);

$client->check('壊れた JSON は 400 invalid_json', (static function () use ($client, $token, $missingId): bool {
    $response = $client->request(
        'PUT',
        '/api/vault/' . $missingId,
        ['Authorization' => test_bearer($token), 'Content-Type' => 'application/json'],
        '{"envelope":',
    );
    return $response['status'] === 400 && ($response['json']['error'] ?? null) === 'invalid_json';
})());

$client->check('必須フィールド欠落は 400 invalid_body', (static function () use ($client, $token, $missingId): bool {
    $response = $client->request(
        'PUT',
        '/api/vault/' . $missingId,
        ['Authorization' => test_bearer($token), 'Content-Type' => 'application/json'],
        '{"envelope":{"format":"aegis-vault"},"revision":1}',
    );
    $issues = is_array($response['json']) && is_array($response['json']['issues'] ?? null) ? $response['json']['issues'] : [];
    return $response['status'] === 400
        && ($response['json']['error'] ?? null) === 'invalid_body'
        && in_array('envelope.version', $issues, true)
        && in_array('envelope.kdf', $issues, true);
})());

$client->check('負の revision は 400', (static function () use ($client, $token, $missingId): bool {
    $envelope = test_envelope(1);
    $envelope['revision'] = -1;
    $response = $client->request(
        'PUT',
        '/api/vault/' . $missingId,
        ['Authorization' => test_bearer($token), 'Content-Type' => 'application/json'],
        test_put_body($envelope, -1),
    );
    $issues = is_array($response['json']) && is_array($response['json']['issues'] ?? null) ? $response['json']['issues'] : [];
    return $response['status'] === 400
        && in_array('revision', $issues, true)
        && in_array('envelope.revision', $issues, true);
})());

$client->check('未知のキーは 400（zod strict と同じ issues）', (static function () use ($client, $token, $vaultId): bool {
    $body = json_decode(test_put_body(test_envelope(3), 2), true);
    $body['extra'] = true;
    $response = $client->request(
        'PUT',
        '/api/vault/' . $vaultId,
        ['Authorization' => test_bearer($token), 'Content-Type' => 'application/json'],
        (string) json_encode($body),
    );
    $issues = is_array($response['json']) && is_array($response['json']['issues'] ?? null) ? $response['json']['issues'] : [];
    return $response['status'] === 400 && in_array('', $issues, true);
})());

$client->check('envelope.revision が基準以下なら 400 revision_must_advance', (static function () use ($client, $token, $vaultId): bool {
    $response = $client->request(
        'PUT',
        '/api/vault/' . $vaultId,
        ['Authorization' => test_bearer($token), 'Content-Type' => 'application/json'],
        test_put_body(test_envelope(2), 2),
    );
    return $response['status'] === 400 && ($response['json']['error'] ?? null) === 'revision_must_advance';
})());

$client->check('POST は 404 not_found', (static function () use ($client, $vaultId, $token): bool {
    $response = $client->request(
        'POST',
        '/api/vault/' . $vaultId,
        ['Authorization' => test_bearer($token), 'Content-Type' => 'application/json'],
        '{}',
    );
    return $response['status'] === 404 && ($response['json']['error'] ?? null) === 'not_found';
})());

// サーバーが持つのは暗号文とトークンのハッシュだけ。
if ($dbPath !== '') {
    $pdo = new PDO('sqlite:' . $dbPath, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    $row = $pdo->prepare('SELECT token_hash, envelope, revision FROM vaults WHERE id = ?');
    $row->execute([$vaultId]);
    $stored = $row->fetch();
    $client->check('token_hash は SHA-256 hex（トークンそのものは保存しない）', is_array($stored) && ($stored['token_hash'] ?? '') === hash('sha256', $token));
    $client->check('保存された封筒は送信した封筒と同じ', is_array($stored) && json_decode((string) $stored['envelope'], true) == $envelope2);
    $client->check('revision 列が更新されている', is_array($stored) && (int) $stored['revision'] === 2);
    $client->check('DB ファイルに生のトークンが含まれない', !str_contains((string) file_get_contents($dbPath), $token));
}

$delete = $client->request('DELETE', '/api/vault/' . $vaultId, ['Authorization' => test_bearer($token)]);
$client->check('削除は 204（本文なし）', $delete['status'] === 204 && $delete['body'] === '', 'status=' . $delete['status']);
$client->check('削除後は 404', $client->request('GET', '/api/vault/' . $vaultId, ['Authorization' => test_bearer($token)])['status'] === 404);

// ---------------------------------------------------------------------------
$client->section('ボディサイズ上限（256 KiB）');

$bigToken = test_token();
$bigId = test_vault_id($bigToken);
$tooLarge = $client->request(
    'PUT',
    '/api/vault/' . $bigId,
    ['Authorization' => test_bearer($bigToken), 'Content-Type' => 'application/json'],
    '{"pad":"' . str_repeat('x', 300 * 1024) . '"}',
);
$client->check('300 KiB は 413', $tooLarge['status'] === 413, 'status=' . $tooLarge['status']);
$client->check('413 に limit が入る', ($tooLarge['json']['limit'] ?? null) === 262144);
$client->check('413 の error は payload_too_large', ($tooLarge['json']['error'] ?? null) === 'payload_too_large');

$chunkedToken = test_token();
$chunkedId = test_vault_id($chunkedToken);
$chunked = $client->chunked(
    'PUT',
    '/api/vault/' . $chunkedId,
    ['Authorization' => test_bearer($chunkedToken), 'Content-Type' => 'application/json'],
    '{"pad":"' . str_repeat('y', 320 * 1024) . '"}',
);
$client->check('Content-Length 無し（chunked）でも 413', $chunked['status'] === 413, 'status=' . $chunked['status']);

$smallToken = test_token();
$smallId = test_vault_id($smallToken);
$smallEnvelope = test_envelope(1);
$smallChunked = $client->chunked(
    'PUT',
    '/api/vault/' . $smallId,
    ['Authorization' => test_bearer($smallToken), 'Content-Type' => 'application/json'],
    test_put_body($smallEnvelope, 0),
);
$client->check('chunked でも上限内なら 200', $smallChunked['status'] === 200 && ($smallChunked['json']['revision'] ?? null) === 1, 'status=' . $smallChunked['status']);

// ---------------------------------------------------------------------------
$client->section('破損した行の扱い');

if ($dbPath !== '') {
    $brokenToken = test_token();
    $brokenId = test_vault_id($brokenToken);
    $created = $client->request(
        'PUT',
        '/api/vault/' . $brokenId,
        ['Authorization' => test_bearer($brokenToken), 'Content-Type' => 'application/json'],
        test_put_body(test_envelope(1), 0),
    );
    $client->check('破損テスト用のボルトを作成できる', $created['status'] === 200);

    $pdo = new PDO('sqlite:' . $dbPath, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $pdo->prepare('UPDATE vaults SET envelope = ? WHERE id = ?')->execute(['{broken', $brokenId]);

    $corrupt = $client->request('GET', '/api/vault/' . $brokenId, ['Authorization' => test_bearer($brokenToken)]);
    $client->check('JSON として読めない行は 409 corrupt_vault', $corrupt['status'] === 409 && ($corrupt['json']['error'] ?? null) === 'corrupt_vault', 'status=' . $corrupt['status']);

    $client->request('DELETE', '/api/vault/' . $brokenId, ['Authorization' => test_bearer($brokenToken)]);
}

exit($client->summary('api-compat'));
