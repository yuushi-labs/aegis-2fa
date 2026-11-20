<?php
/**
 * SQLite による IP 単位の固定ウィンドウ・レート制限。
 *
 * 挙動は server/middleware/rateLimit.ts と同じ:
 * - 上限超過は 429 と Retry-After、上限内なら X-RateLimit-Limit / X-RateLimit-Remaining
 * - キーは接続元 IP。転送ヘッダは trust_proxy のときだけ採用し、
 *   X-Forwarded-For を右端から trust_proxy_hops 番目で数える（左端は偽装できる）。
 * - X-Real-IP は読まない。
 */

declare(strict_types=1);

namespace Aegis;

use PDO;

final class RateLimiter
{
    public function __construct(
        private readonly PDO $pdo,
        private readonly string $name,
        private readonly int $windowMs,
        private readonly int $max,
    ) {
    }

    /**
     * @return array{allowed: bool, limit: int, remaining: int, retryAfter: int}
     */
    public function hit(string $ip): array
    {
        $now = (int) round(microtime(true) * 1000);
        $resetAt = $now + $this->windowMs;
        $key = $this->name . ':' . $ip;

        $upsert = $this->pdo->prepare(
            'INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)'
            . ' ON CONFLICT(key) DO UPDATE SET'
            . ' count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,'
            . ' reset_at = CASE WHEN rate_limits.reset_at <= ? THEN ? ELSE rate_limits.reset_at END',
        );
        $upsert->execute([$key, $resetAt, $now, $now, $resetAt]);

        $select = $this->pdo->prepare('SELECT count, reset_at FROM rate_limits WHERE key = ?');
        $select->execute([$key]);
        $row = $select->fetch();

        $count = is_array($row) ? (int) $row['count'] : 1;
        $bucketResetAt = is_array($row) ? (int) $row['reset_at'] : $resetAt;

        if (random_int(1, 50) === 1) {
            $this->pdo->prepare('DELETE FROM rate_limits WHERE reset_at <= ?')->execute([$now]);
        }

        if ($count > $this->max) {
            return [
                'allowed' => false,
                'limit' => $this->max,
                'remaining' => 0,
                'retryAfter' => max(1, (int) ceil(($bucketResetAt - $now) / 1000)),
            ];
        }

        return [
            'allowed' => true,
            'limit' => $this->max,
            'remaining' => max(0, $this->max - $count),
            'retryAfter' => 0,
        ];
    }

    /** レート制限のキーにするクライアント IP。 */
    public static function clientIp(Request $request, Config $config): string
    {
        if ($config->trustProxy) {
            $forwarded = $request->header('x-forwarded-for');
            if ($forwarded !== null && trim($forwarded) !== '') {
                $parts = [];
                foreach (explode(',', $forwarded) as $part) {
                    $part = trim($part);
                    if ($part !== '') {
                        $parts[] = $part;
                    }
                }
                $hops = $config->trustProxyHops;
                $candidate = $parts[max(0, count($parts) - $hops)] ?? null;
                if (is_string($candidate) && $candidate !== '') {
                    return $candidate;
                }
            }
            return $request->remoteAddr ?? 'unknown';
        }

        return $request->remoteAddr ?? 'local';
    }
}
