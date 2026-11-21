<?php
/**
 * レート制限の互換テスト。
 *
 * シナリオ（AEGIS_TEST_SCENARIO）:
 *   untrusted … 既定（TRUST_PROXY なし）のサーバー。X-Forwarded-For を変えても回避できない。
 *   trusted   … TRUST_PROXY=true のサーバー。転送ヘッダの値ごとに数える。
 *   untrusted-peer … TRUST_PROXY=true でも接続元が TRUST_PROXY_IPS に無いサーバー。転送ヘッダを無視する。
 *   put       … 書き込み（PUT）が 20 req/min で制限される。
 *   create    … 新規作成だけの別バケット（既定 10/時）が効き、既存の更新は妨げない。
 *
 * どのシナリオも 1 つのサーバーを専有する（バケットは IP 単位なので、別シナリオと共有できない）。
 */

declare(strict_types=1);

require __DIR__ . '/lib.php';

$baseUrl = rtrim((string) (getenv('AEGIS_TEST_BASE_URL') ?: 'http://127.0.0.1:8911'), '/');
$basePath = (string) (getenv('AEGIS_TEST_BASE') ?: '');
if ($basePath === '/') {
    $basePath = '';
}
$scenario = (string) (getenv('AEGIS_TEST_SCENARIO') ?: 'untrusted');

$client = new TestClient($baseUrl, $basePath);
$token = test_token();
$vaultId = test_vault_id($token);

$client->section('レート制限: ' . $scenario);

switch ($scenario) {
    case 'untrusted':
        $first60 = [];
        for ($i = 0; $i < 60; $i += 1) {
            $first60[] = $client->request(
                'GET',
                '/api/vault/' . $vaultId . '/meta',
                ['Authorization' => test_bearer($token), 'X-Forwarded-For' => '10.0.0.' . $i],
            );
        }
        $statuses = array_column($first60, 'status');
        $client->check('60 回までは 404（上限内）', array_unique($statuses) === [404], implode(',', array_unique($statuses)));
        $client->check('X-RateLimit-Limit: 60 が付く', ($first60[0]['headers']['x-ratelimit-limit'] ?? null) === '60');

        $limited = $client->request(
            'GET',
            '/api/vault/' . $vaultId . '/meta',
            ['Authorization' => test_bearer($token), 'X-Forwarded-For' => '10.9.9.9'],
        );
        $client->check('61 回目は 429', $limited['status'] === 429, 'status=' . $limited['status']);
        $client->check('429 の error は rate_limited', ($limited['json']['error'] ?? null) === 'rate_limited');
        $client->check('Retry-After が 1 以上', (int) ($limited['headers']['retry-after'] ?? 0) >= 1, (string) ($limited['headers']['retry-after'] ?? 'none'));
        $client->check(
            '本文の retryAfter とヘッダが一致する',
            ($limited['json']['retryAfter'] ?? null) === (int) ($limited['headers']['retry-after'] ?? -1),
        );
        break;

    case 'trusted':
        $perIp = [];
        for ($i = 0; $i < 61; $i += 1) {
            $perIp[] = $client->request(
                'GET',
                '/api/vault/' . $vaultId . '/meta',
                ['Authorization' => test_bearer($token), 'X-Forwarded-For' => '10.0.1.' . $i],
            );
        }
        $statuses = array_unique(array_column($perIp, 'status'));
        $client->check('転送ヘッダごとに数える（61 回とも 404）', $statuses === [404], implode(',', $statuses));

        $last = null;
        for ($i = 0; $i < 61; $i += 1) {
            $last = $client->request(
                'GET',
                '/api/vault/' . $vaultId . '/meta',
                ['Authorization' => test_bearer($token), 'X-Forwarded-For' => '10.0.2.1'],
            );
        }
        $client->check('同じ転送ヘッダを繰り返すと 429', ($last['status'] ?? 0) === 429, 'status=' . ($last['status'] ?? 0));
        break;

    case 'untrusted-peer':
        // 接続元（127.0.0.1）は TRUST_PROXY_IPS に含めない。転送ヘッダを変えても 1 つのバケットで数える。
        $spoofed = [];
        for ($i = 0; $i < 61; $i += 1) {
            $spoofed[] = $client->request(
                'GET',
                '/api/vault/' . $vaultId . '/meta',
                ['Authorization' => test_bearer($token), 'X-Forwarded-For' => '10.0.3.' . $i],
            );
        }
        $client->check('60 回までは 404（上限内）', ($spoofed[59]['status'] ?? 0) === 404, 'status=' . ($spoofed[59]['status'] ?? 0));
        $client->check(
            '信頼しない接続元の転送ヘッダでは回避できない（61 回目は 429）',
            ($spoofed[60]['status'] ?? 0) === 429,
            'status=' . ($spoofed[60]['status'] ?? 0),
        );
        break;

    case 'put':
        $envelope = test_envelope(1);
        $body = test_put_body($envelope, 0);
        $responses = [];
        for ($i = 0; $i < 21; $i += 1) {
            $responses[] = $client->request(
                'PUT',
                '/api/vault/' . $vaultId,
                ['Authorization' => test_bearer($token), 'Content-Type' => 'application/json'],
                $body,
            );
        }
        $client->check('1 回目は 200', ($responses[0]['status'] ?? 0) === 200, 'status=' . ($responses[0]['status'] ?? 0));
        $client->check('2 回目以降は 409（同じ revision）', ($responses[1]['status'] ?? 0) === 409, 'status=' . ($responses[1]['status'] ?? 0));
        $client->check('20 回目までは 200/409（制限内）', ($responses[19]['status'] ?? 0) === 409, 'status=' . ($responses[19]['status'] ?? 0));
        $client->check('21 回目は 429', ($responses[20]['status'] ?? 0) === 429, 'status=' . ($responses[20]['status'] ?? 0));
        $client->check('PUT の X-RateLimit-Limit は 20', ($responses[0]['headers']['x-ratelimit-limit'] ?? null) === '20');
        $client->check('429 に Retry-After が付く', (int) ($responses[20]['headers']['retry-after'] ?? 0) >= 1);
        break;

    case 'create':
        // 新規作成だけの別バケット（サーバーは CREATE_MAX=2 / ウィンドウ既定 3600 秒）。
        $first = test_token();
        $firstId = test_vault_id($first);
        $create = $client->request(
            'PUT',
            '/api/vault/' . $firstId,
            ['Authorization' => test_bearer($first), 'Content-Type' => 'application/json'],
            test_put_body(test_envelope(1), 0),
        );
        $client->check('1 件目の新規作成は 200', ($create['status'] ?? 0) === 200, 'status=' . ($create['status'] ?? 0));

        $brokenToken = test_token();
        $invalid = $client->request(
            'PUT',
            '/api/vault/' . test_vault_id($brokenToken),
            ['Authorization' => test_bearer($brokenToken), 'Content-Type' => 'application/json'],
            '{not json',
        );
        $client->check('本文が不正な PUT は 400（作成の枠を消費しない）', ($invalid['status'] ?? 0) === 400, 'status=' . ($invalid['status'] ?? 0));

        $second = test_token();
        $created = $client->request(
            'PUT',
            '/api/vault/' . test_vault_id($second),
            ['Authorization' => test_bearer($second), 'Content-Type' => 'application/json'],
            test_put_body(test_envelope(1), 0),
        );
        $client->check('2 件目の新規作成は 200（上限内）', ($created['status'] ?? 0) === 200, 'status=' . ($created['status'] ?? 0));

        $third = test_token();
        $thirdId = test_vault_id($third);
        $limited = $client->request(
            'PUT',
            '/api/vault/' . $thirdId,
            ['Authorization' => test_bearer($third), 'Content-Type' => 'application/json'],
            test_put_body(test_envelope(1), 0),
        );
        $client->check('上限を超える 3 件目は 429', ($limited['status'] ?? 0) === 429, 'status=' . ($limited['status'] ?? 0));
        $client->check('429 の error は rate_limited', ($limited['json']['error'] ?? null) === 'rate_limited');
        $client->check('429 の scope は vault_create', ($limited['json']['scope'] ?? null) === 'vault_create');
        $client->check(
            '429 に Retry-After が付く（1 以上）',
            (int) ($limited['headers']['retry-after'] ?? 0) >= 1,
            (string) ($limited['headers']['retry-after'] ?? 'none'),
        );
        $client->check(
            '本文の retryAfter とヘッダが一致する',
            ($limited['json']['retryAfter'] ?? null) === (int) ($limited['headers']['retry-after'] ?? -1),
        );
        $client->check(
            '429 の X-RateLimit-Limit は作成の上限（2）',
            ($limited['headers']['x-ratelimit-limit'] ?? null) === '2',
            (string) ($limited['headers']['x-ratelimit-limit'] ?? 'none'),
        );

        $notCreated = $client->request('GET', '/api/vault/' . $thirdId . '/meta', ['Authorization' => test_bearer($third)]);
        $client->check('429 のボルトは作られていない（404）', ($notCreated['status'] ?? 0) === 404, 'status=' . ($notCreated['status'] ?? 0));

        $update = $client->request(
            'PUT',
            '/api/vault/' . $firstId,
            ['Authorization' => test_bearer($first), 'Content-Type' => 'application/json'],
            test_put_body(test_envelope(2), 1),
        );
        $client->check(
            '枠を使い切っても既存ボルトの更新は通る（200）',
            ($update['status'] ?? 0) === 200,
            'status=' . ($update['status'] ?? 0),
        );
        break;

    default:
        fwrite(STDERR, "未知のシナリオ: $scenario\n");
        exit(1);
}

exit($client->summary('rate-limit:' . $scenario));
