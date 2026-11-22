<?php
/**
 * Hono 実装（server/app.ts + server/routes/*）と同じ API を PHP で提供する。
 *
 * 応答の形式・ステータスコード・処理順は Node 版に合わせている:
 *   セキュリティヘッダ → ログ → CORS → レート制限 → ボディ上限 → ルーティング
 * 認可は「vaultId = hex(SHA-256(token))[0:32]」の一致と tokenHash の一致の両方。
 * 不一致はすべて 404（ボルトの存在を漏らさない）。
 */

declare(strict_types=1);

namespace Zekey;

use RuntimeException;
use Throwable;

final class Application
{
    /** ボディ上限（server/middleware/bodyLimit.ts の既定値と同じ 256 KiB）。 */
    public const BODY_LIMIT = 262144;

    /** 32 桁 hex。末尾の改行を許さないよう \z で終端する。 */
    private const VAULT_ID_PATTERN = '/^[0-9a-f]{32}\z/';

    public static function run(string $appDir): void
    {
        self::handle($appDir)->send();
    }

    public static function handle(string $appDir, ?Request $request = null): Response
    {
        $request ??= Request::fromGlobals();
        $config = null;

        try {
            $config = Config::load($appDir);
            $response = self::dispatch($config, $request);
        } catch (Throwable $error) {
            error_log('[zekey] ' . $error::class . ': ' . $error->getMessage());
            $message = $config !== null && $config->debug ? $error->getMessage() : 'internal_error';
            $response = Response::error('internal_error', 500, ['message' => $message]);
        }

        $https = $config?->https ?? $request->isHttps;
        return $response->withHeaders(Security::headers($https, $request->path));
    }

    private static function dispatch(Config $config, Request $request): Response
    {
        $path = $request->path;
        $isApi = str_starts_with($path, '/api/');
        $isVaultPath = str_starts_with($path, '/api/vault/');

        // 1) CORS（別オリジンから API を使う設定のときだけ。既定では何もしない）
        if ($config->corsOrigin !== null && $isApi && $request->method === 'OPTIONS') {
            return new Response(204, '', [
                'Access-Control-Allow-Origin' => $config->corsOrigin,
                'Access-Control-Allow-Methods' => 'GET, PUT, DELETE, OPTIONS',
                'Access-Control-Allow-Headers' => 'Authorization, Content-Type',
                'Access-Control-Max-Age' => '600',
            ]);
        }
        $corsHeaders = $config->corsOrigin !== null && $isApi
            ? ['Access-Control-Allow-Origin' => $config->corsOrigin]
            : [];

        // 2) データベース（health と /api/vault/* だけ開く）
        $needsDatabase = $isVaultPath || ($path === '/api/health' && $request->method === 'GET');
        $database = null;
        $databaseError = null;
        if ($needsDatabase) {
            try {
                $database = Database::open($config->dbPath);
            } catch (Throwable $error) {
                $databaseError = $error;
            }
        }

        if ($path === '/api/health' && $request->method === 'GET') {
            return self::finish(Health::respond($database, $config->version), [], $corsHeaders);
        }

        if (!$needsDatabase) {
            return self::finish(Response::error('not_found', 404), [], $corsHeaders);
        }

        if ($database === null) {
            throw $databaseError ?? new RuntimeException('データベースを開けません');
        }

        // 3) レート制限（/api/vault/* は 60 req/min、PUT は 20 req/min、新規作成は 10 req/hour）
        $rateHeaders = [];
        $createLimiter = null;
        $clientIp = '';
        if ($isVaultPath && $config->rateLimit) {
            $ip = RateLimiter::clientIp($request, $config);
            $clientIp = $ip;
            $windowMs = $config->rateLimitWindowSeconds * 1000;

            $readLimiter = new RateLimiter($database->pdo(), 'vault', $windowMs, $config->rateLimitReadMax);
            $read = $readLimiter->hit($ip);
            if (!$read['allowed']) {
                return self::finish(
                    Response::error('rate_limited', 429, ['retryAfter' => $read['retryAfter']])
                        ->withHeaders(['Retry-After' => (string) $read['retryAfter']]),
                    [],
                    $corsHeaders,
                );
            }
            $rateHeaders = [
                'X-RateLimit-Limit' => (string) $read['limit'],
                'X-RateLimit-Remaining' => (string) $read['remaining'],
            ];

            if ($request->method === 'PUT') {
                $writeLimiter = new RateLimiter($database->pdo(), 'vault-put', $windowMs, $config->rateLimitWriteMax);
                $write = $writeLimiter->hit($ip);
                if (!$write['allowed']) {
                    return self::finish(
                        Response::error('rate_limited', 429, ['retryAfter' => $write['retryAfter']])
                            ->withHeaders(['Retry-After' => (string) $write['retryAfter']]),
                        $rateHeaders,
                        $corsHeaders,
                    );
                }
                $rateHeaders['X-RateLimit-Limit'] = (string) $write['limit'];
                $rateHeaders['X-RateLimit-Remaining'] = (string) $write['remaining'];

                // 新規作成だけの別バケット（既定 10 回/時/IP）。
                // 「新規かどうか」はトークンの検証後、putVault のトランザクション内で
                // 判定する（無効な本文や既存ボルトの更新で枠を消費しない）。
                $createLimiter = new RateLimiter(
                    $database->pdo(),
                    'vault-create',
                    $config->rateLimitCreateWindowSeconds * 1000,
                    $config->rateLimitCreateMax,
                );
            }
        }

        // 4) ボディ上限（Content-Length と実バイト数の両方で検査する）
        $rawBody = '';
        if ($isVaultPath && !in_array($request->method, ['GET', 'HEAD', 'DELETE'], true)) {
            $declaredHeader = $request->header('content-length');
            if ($declaredHeader !== null) {
                $declared = self::parseContentLength($declaredHeader);
                if ($declared === null || $declared < 0) {
                    return self::finish(Response::error('invalid_content_length', 400), $rateHeaders, $corsHeaders);
                }
                if ($declared > self::BODY_LIMIT) {
                    return self::finish(
                        Response::error('payload_too_large', 413, ['limit' => self::BODY_LIMIT]),
                        $rateHeaders,
                        $corsHeaders,
                    );
                }
            }

            $body = Request::readBody(self::BODY_LIMIT);
            if ($body['tooLarge']) {
                return self::finish(
                    Response::error('payload_too_large', 413, ['limit' => self::BODY_LIMIT]),
                    $rateHeaders,
                    $corsHeaders,
                );
            }
            $rawBody = $body['body'];
        }

        // 5) ルーティング
        $repository = new VaultRepository($database->pdo());

        if ($request->method === 'GET' && preg_match('#^/api/vault/([^/]+)/meta$#', $path, $matches) === 1) {
            $response = self::getMeta($repository, $matches[1], $request);
        } elseif (preg_match('#^/api/vault/([^/]+)$#', $path, $matches) === 1) {
            $id = $matches[1];
            $response = match ($request->method) {
                'GET' => self::getVault($repository, $id, $request),
                'PUT' => self::putVault(
                    $database,
                    $repository,
                    $id,
                    $request,
                    $rawBody,
                    $config->maxVaultBytes,
                    $createLimiter,
                    $clientIp,
                ),
                'DELETE' => self::deleteVault($repository, $id, $request),
                default => Response::error('not_found', 404),
            };
        } else {
            // /api/* の未知パス（Hono の notFound と同じ JSON 404）。
            $response = Response::error('not_found', 404);
        }

        return self::finish($response, $rateHeaders, $corsHeaders);
    }

    private static function getVault(VaultRepository $repository, string $id, Request $request): Response
    {
        $row = self::authorize($repository, $id, $request->header('authorization'));
        if ($row === null) {
            return Response::error('not_found', 404);
        }

        $envelope = json_decode($row['envelope']);
        if (json_last_error() !== JSON_ERROR_NONE) {
            // 破損した行は 500 ではなく明示的なエラーにする（クライアントが復旧判断できる）。
            return Response::error('corrupt_vault', 409);
        }

        return Response::json(['envelope' => $envelope, 'revision' => $row['revision']]);
    }

    private static function getMeta(VaultRepository $repository, string $id, Request $request): Response
    {
        $row = self::authorize($repository, $id, $request->header('authorization'));
        if ($row === null) {
            return Response::error('not_found', 404);
        }

        return Response::json(['revision' => $row['revision'], 'updatedAt' => $row['updated_at']]);
    }

    private static function putVault(
        Database $database,
        VaultRepository $repository,
        string $id,
        Request $request,
        string $rawBody,
        int $maxVaultBytes,
        ?RateLimiter $createLimiter,
        string $clientIp,
    ): Response {
        if (preg_match(self::VAULT_ID_PATTERN, $id) !== 1) {
            return Response::error('invalid_vault_id', 400);
        }

        $decoded = json_decode($rawBody);
        if (json_last_error() !== JSON_ERROR_NONE) {
            return Response::error('invalid_json', 400);
        }

        $validation = Validation::putBody($decoded);
        if ($validation['value'] === null) {
            return Response::error('invalid_body', 400, ['issues' => $validation['issues']]);
        }

        $envelope = $validation['value']['envelope'];
        $baseRevision = $validation['value']['revision'];

        // body の revision は「クライアントが現在保持している revision」（楽観ロックの基準）。
        // envelope.revision は「書き込み後の新しい revision」。
        $nextRevision = (int) $envelope['revision'];
        if ($nextRevision <= $baseRevision) {
            return Response::error('revision_must_advance', 400);
        }

        $token = self::bearerToken($request->header('authorization'));
        if ($token === null || strlen($token) < 32) {
            return Response::error('not_found', 404);
        }
        // 仕様: vaultId = hex(SHA-256(token))[0:32]。導出できない ID は受け付けない
        // （未認証の第三者が任意の ID で行を作る／名前空間を占有するのを防ぐ）。
        if (!hash_equals(self::deriveVaultId($token), $id)) {
            return Response::error('not_found', 404);
        }
        $tokenHash = self::deriveTokenHash($token);

        $serialized = json_encode($envelope, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (!is_string($serialized)) {
            return Response::error('invalid_body', 400, ['issues' => []]);
        }
        $incomingBytes = strlen($serialized);
        $now = self::isoNow();

        return $database->immediate(
            static function () use (
                $repository,
                $id,
                $tokenHash,
                $serialized,
                $incomingBytes,
                $baseRevision,
                $nextRevision,
                $now,
                $maxVaultBytes,
                $createLimiter,
                $clientIp,
            ): Response {
                $existing = $repository->find($id);

                if ($existing === null) {
                    // 束縛されていない新規ボルトの作成は、通常の PUT（20/分）とは別に
                    // 厳しいバケット（既定 10/時/IP）で制限する。正規ユーザーの同期は
                    // 既存ボルトへの更新なので、このバケットを消費しない。
                    if ($createLimiter !== null) {
                        $create = $createLimiter->hit($clientIp);
                        if (!$create['allowed']) {
                            return Response::error('rate_limited', 429, [
                                'retryAfter' => $create['retryAfter'],
                                'scope' => 'vault_create',
                            ])->withHeaders([
                                'Retry-After' => (string) $create['retryAfter'],
                                'X-RateLimit-Limit' => (string) $create['limit'],
                                'X-RateLimit-Remaining' => '0',
                            ]);
                        }
                    }
                    if ($repository->storedBytes() + $incomingBytes > $maxVaultBytes) {
                        return Response::error('storage_limit', 507);
                    }
                    $repository->insert($id, $tokenHash, $serialized, $nextRevision, $now);
                    return Response::json(['revision' => $nextRevision]);
                }

                if (!hash_equals($existing['token_hash'], $tokenHash)) {
                    // 既存ボルトへの別トークンでの書き込みは存在を漏らさず 404。
                    return Response::error('not_found', 404);
                }
                if ($existing['revision'] !== $baseRevision) {
                    return Response::json(
                        ['error' => 'conflict', 'currentRevision' => $existing['revision']],
                        409,
                    );
                }

                $existingBytes = strlen($existing['envelope']);
                if ($repository->storedBytes() - $existingBytes + $incomingBytes > $maxVaultBytes) {
                    return Response::error('storage_limit', 507);
                }

                $repository->update($id, $serialized, $nextRevision, $now);
                return Response::json(['revision' => $nextRevision]);
            },
        );
    }

    private static function deleteVault(VaultRepository $repository, string $id, Request $request): Response
    {
        $row = self::authorize($repository, $id, $request->header('authorization'));
        if ($row === null) {
            return Response::error('not_found', 404);
        }

        $repository->delete($id);
        return Response::noContent();
    }

    /**
     * 認可: vaultId がトークンから導出でき、かつ token_hash が一致したときのみ。
     * 不一致は 404（ボルトの存在を漏らさない）。
     *
     * @return array{id: string, token_hash: string, envelope: string, revision: int, created_at: string, updated_at: string}|null
     */
    private static function authorize(VaultRepository $repository, string $id, ?string $authorization): ?array
    {
        if (preg_match(self::VAULT_ID_PATTERN, $id) !== 1) {
            return null;
        }

        $token = self::bearerToken($authorization);
        if ($token === null || strlen($token) < 32) {
            return null;
        }
        if (!hash_equals(self::deriveVaultId($token), $id)) {
            return null;
        }

        $row = $repository->find($id);
        if ($row === null) {
            return null;
        }
        if (!hash_equals($row['token_hash'], self::deriveTokenHash($token))) {
            return null;
        }

        return $row;
    }

    private static function bearerToken(?string $header): ?string
    {
        if ($header === null) {
            return null;
        }
        if (preg_match('/^Bearer\s+(\S+)$/i', trim($header), $matches) !== 1) {
            return null;
        }
        return $matches[1];
    }

    /** vaultId = hex(SHA-256(token))[0:32]（shared/sync.ts と同じ）。 */
    private static function deriveVaultId(string $token): string
    {
        return substr(self::deriveTokenHash($token), 0, 32);
    }

    /** tokenHash = SHA-256 hex 全長。トークンそのものは保存しない。 */
    private static function deriveTokenHash(string $token): string
    {
        return hash('sha256', $token);
    }

    /** Number.parseInt 相当（先頭の数値だけ読む。数値が無ければ null）。 */
    private static function parseContentLength(string $value): ?int
    {
        if (preg_match('/^\s*([+-]?\d+)/', $value, $matches) !== 1) {
            return null;
        }
        return (int) $matches[1];
    }

    /** Date#toISOString と同じ形式（ミリ秒 3 桁 + Z）。 */
    private static function isoNow(): string
    {
        $now = microtime(true);
        $seconds = (int) floor($now);
        $milliseconds = (int) round(($now - $seconds) * 1000);
        if ($milliseconds >= 1000) {
            $seconds += 1;
            $milliseconds -= 1000;
        }
        return gmdate('Y-m-d\TH:i:s', $seconds) . sprintf('.%03dZ', $milliseconds);
    }

    /**
     * @param array<string, string> $rateHeaders
     * @param array<string, string> $corsHeaders
     */
    private static function finish(Response $response, array $rateHeaders, array $corsHeaders): Response
    {
        return $response->withHeaders($rateHeaders)->withHeaders($corsHeaders);
    }
}
