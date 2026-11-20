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
    /** RETURNING 句（SQLite 3.35 以降）が使えるか。同じ SQLite を使うので 1 回だけ調べる。 */
    private static ?bool $returningSupported = null;

    public function __construct(
        private readonly PDO $pdo,
        private readonly string $name,
        private readonly int $windowMs,
        private readonly int $max,
    ) {
    }

    /**
     * 1 リクエスト分を加算し、そのリクエスト自身の加算結果で判定する。
     *
     * @return array{allowed: bool, limit: int, remaining: int, retryAfter: int}
     */
    public function hit(string $ip): array
    {
        $now = (int) round(microtime(true) * 1000);
        $resetAt = $now + $this->windowMs;
        $key = $this->name . ':' . $ip;

        $upsertSql = 'INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)'
            . ' ON CONFLICT(key) DO UPDATE SET'
            . ' count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,'
            . ' reset_at = CASE WHEN rate_limits.reset_at <= ? THEN ? ELSE rate_limits.reset_at END';
        $parameters = [$key, $resetAt, $now, $now, $resetAt];

        $row = null;
        if ($this->supportsReturning()) {
            // 加算と結果の取得が 1 文で完結するので、他の要求の加算に影響されない。
            $statement = $this->pdo->prepare($upsertSql . ' RETURNING count, reset_at');
            $statement->execute($parameters);
            $fetched = $statement->fetch();
            $statement->closeCursor();
            $row = is_array($fetched) ? $fetched : null;
        } else {
            // SQLite 3.35 未満向けの 2 段階（加算と取得の間に他の要求が入り得る）。
            $this->pdo->prepare($upsertSql)->execute($parameters);
            $select = $this->pdo->prepare('SELECT count, reset_at FROM rate_limits WHERE key = ?');
            $select->execute([$key]);
            $fetched = $select->fetch();
            $row = is_array($fetched) ? $fetched : null;
        }

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

    /** RETURNING 句が使える SQLite か（3.35 以降）。 */
    private function supportsReturning(): bool
    {
        if (self::$returningSupported === null) {
            $version = (string) $this->pdo->query('select sqlite_version()')->fetchColumn();
            self::$returningSupported = version_compare($version, '3.35.0', '>=');
        }
        return self::$returningSupported;
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
