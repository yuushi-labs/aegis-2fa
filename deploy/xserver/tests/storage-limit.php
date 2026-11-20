<?php
/**
 * 保存量の上限（MAX_VAULT_BYTES）の互換テスト。上限を小さくしたサーバーに対して実行する。
 *
 * Node 版と同じく、暗号文の総量が上限を超える書き込みは 507 storage_limit。
 * 更新のときは「総量 − その行の旧サイズ + 新サイズ」で判定する。
 */

declare(strict_types=1);

require __DIR__ . '/lib.php';

$baseUrl = rtrim((string) (getenv('AEGIS_TEST_BASE_URL') ?: 'http://127.0.0.1:8914'), '/');
$basePath = (string) (getenv('AEGIS_TEST_BASE') ?: '');
if ($basePath === '/') {
    $basePath = '';
}
$limit = (int) (getenv('AEGIS_TEST_MAX_VAULT_BYTES') ?: 8192);

$client = new TestClient($baseUrl, $basePath);
$client->section('保存量の上限（' . $limit . ' bytes）');

$tokenA = test_token();
$idA = test_vault_id($tokenA);
$tokenB = test_token();
$idB = test_vault_id($tokenB);

$first = $client->request(
    'PUT',
    '/api/vault/' . $idA,
    ['Authorization' => test_bearer($tokenA), 'Content-Type' => 'application/json'],
    test_put_body(test_envelope(1, str_repeat('A', 5000)), 0),
);
$client->check('1 件目は上限内で作成できる', $first['status'] === 200, 'status=' . $first['status']);

$second = $client->request(
    'PUT',
    '/api/vault/' . $idB,
    ['Authorization' => test_bearer($tokenB), 'Content-Type' => 'application/json'],
    test_put_body(test_envelope(1, str_repeat('B', 5000)), 0),
);
$client->check('総量が上限を超える新規作成は 507', $second['status'] === 507, 'status=' . $second['status']);
$client->check('507 の error は storage_limit', ($second['json']['error'] ?? null) === 'storage_limit');

$grow = $client->request(
    'PUT',
    '/api/vault/' . $idA,
    ['Authorization' => test_bearer($tokenA), 'Content-Type' => 'application/json'],
    test_put_body(test_envelope(2, str_repeat('C', 9000)), 1),
);
$client->check('更新後の総量が上限を超えるなら 507', $grow['status'] === 507, 'status=' . $grow['status']);

$shrink = $client->request(
    'PUT',
    '/api/vault/' . $idA,
    ['Authorization' => test_bearer($tokenA), 'Content-Type' => 'application/json'],
    test_put_body(test_envelope(2, str_repeat('D', 2000)), 1),
);
$client->check('同じ行のサイズを差し引いて判定する（縮小は 200）', $shrink['status'] === 200, 'status=' . $shrink['status']);

exit($client->summary('storage-limit'));
