<?php
/**
 * 設定の読み込み。既定値（config.php）→ 設定ファイル → 環境変数の順で上書きする。
 *
 * Xserver の共用サーバーでは環境変数を自由に置けないことが多いため、
 * 実運用では公開ディレクトリ外の aegis-config.php を使うのが確実。
 */

declare(strict_types=1);

namespace Aegis;

final class Config
{
    private function __construct(
        public readonly string $dbPath,
        public readonly int $maxVaultBytes,
        public readonly ?string $corsOrigin,
        public readonly bool $trustProxy,
        public readonly int $trustProxyHops,
        public readonly ?bool $https,
        public readonly bool $rateLimit,
        public readonly int $rateLimitReadMax,
        public readonly int $rateLimitWriteMax,
        public readonly int $rateLimitWindowSeconds,
        public readonly int $rateLimitCreateMax,
        public readonly int $rateLimitCreateWindowSeconds,
        public readonly bool $debug,
        public readonly string $version,
    ) {
    }

    public static function load(string $appDir): self
    {
        /** @var array<string, mixed> $defaults */
        $defaults = require $appDir . '/config.php';
        $values = $defaults;

        foreach (self::configFiles($appDir) as $file) {
            $override = require $file;
            if (is_array($override)) {
                $values = array_merge($values, $override);
            }
        }

        $values = array_merge($values, self::envOverrides());

        $versionFile = $appDir . '/version.php';
        $version = is_file($versionFile) ? require $versionFile : '1.0.0';
        if (isset($values['version']) && is_string($values['version']) && $values['version'] !== '') {
            $version = $values['version'];
        }

        $corsOrigin = self::nullableString($values['cors_origin'] ?? null);

        return new self(
            dbPath: self::resolveDbPath($values['db_path'] ?? null, $appDir),
            maxVaultBytes: self::positiveInt($values['max_vault_bytes'] ?? 0, 268435456),
            corsOrigin: $corsOrigin === '' ? null : $corsOrigin,
            trustProxy: (bool) ($values['trust_proxy'] ?? false),
            trustProxyHops: min(10, max(1, self::intValue($values['trust_proxy_hops'] ?? 1, 1))),
            https: self::nullableBool($values['https'] ?? null),
            rateLimit: (bool) ($values['rate_limit'] ?? true),
            rateLimitReadMax: self::positiveInt($values['rate_limit_read_max'] ?? 0, 60),
            rateLimitWriteMax: self::positiveInt($values['rate_limit_write_max'] ?? 0, 20),
            rateLimitWindowSeconds: self::positiveInt($values['rate_limit_window_seconds'] ?? 0, 60),
            rateLimitCreateMax: self::positiveInt($values['rate_limit_create_max'] ?? 0, 10),
            rateLimitCreateWindowSeconds: self::positiveInt(
                $values['rate_limit_create_window_seconds'] ?? 0,
                3600,
            ),
            debug: (bool) ($values['debug'] ?? false),
            version: is_string($version) ? $version : '1.0.0',
        );
    }

    /**
     * 設定ファイルの候補（先に見つかったものだけ読む）。
     *
     * @return list<string>
     */
    private static function configFiles(string $appDir): array
    {
        $candidates = [];
        $explicit = getenv('AEGIS_CONFIG');
        if (is_string($explicit) && $explicit !== '') {
            $candidates[] = $explicit;
        }
        // 推奨: 公開ディレクトリの 1 つ上（例: /home/<id>/<domain>/aegis-config.php）。
        $documentRoot = $_SERVER['DOCUMENT_ROOT'] ?? '';
        if (is_string($documentRoot) && $documentRoot !== '' && str_starts_with($documentRoot, '/')) {
            $candidates[] = dirname(rtrim($documentRoot, '/')) . '/aegis-config.php';
        }
        // DOCUMENT_ROOT が無い環境（CLI など）向けの保険。
        $candidates[] = dirname($appDir, 3) . '/aegis-config.php';
        // サイト内で済ませたい場合（storage/ は .htaccess で 403 保護）。
        $candidates[] = dirname($appDir, 1) . '/storage/config.local.php';

        foreach ($candidates as $file) {
            if (is_file($file) && is_readable($file)) {
                return [$file];
            }
        }
        return [];
    }

    /** @return array<string, mixed> */
    private static function envOverrides(): array
    {
        $map = [
            'AEGIS_DB_PATH' => 'db_path',
            'AEGIS_MAX_VAULT_BYTES' => 'max_vault_bytes',
            'AEGIS_CORS_ORIGIN' => 'cors_origin',
            'AEGIS_TRUST_PROXY' => 'trust_proxy',
            'AEGIS_TRUST_PROXY_HOPS' => 'trust_proxy_hops',
            'AEGIS_HTTPS' => 'https',
            'AEGIS_RATE_LIMIT' => 'rate_limit',
            'AEGIS_RATE_LIMIT_READ_MAX' => 'rate_limit_read_max',
            'AEGIS_RATE_LIMIT_WRITE_MAX' => 'rate_limit_write_max',
            'AEGIS_RATE_LIMIT_WINDOW' => 'rate_limit_window_seconds',
            'AEGIS_RATE_LIMIT_CREATE_MAX' => 'rate_limit_create_max',
            'AEGIS_RATE_LIMIT_CREATE_WINDOW' => 'rate_limit_create_window_seconds',
            'AEGIS_DEBUG' => 'debug',
            'AEGIS_VERSION' => 'version',
        ];

        $overrides = [];
        foreach ($map as $env => $key) {
            $raw = getenv($env);
            if (!is_string($raw) || $raw === '') {
                continue;
            }
            $overrides[$key] = match ($key) {
                'db_path', 'cors_origin', 'version' => $raw,
                'trust_proxy', 'rate_limit', 'debug' => self::envBool($raw),
                'https' => self::envNullableBool($raw),
                default => self::envInt($raw),
            };
        }
        return $overrides;
    }

    /**
     * DB の場所。既定では公開ディレクトリの**外**に作る。
     *
     * Xserver は Nginx が静的ファイルを直接配信することがあり、その場合 `.htaccess` の 403 は
     * 効かない。DB を公開ディレクトリ内（storage/ など）に自動で置くと、暗号文と token_hash が
     * `GET /<site>/storage/aegis.db` で読めてしまう構成になり得るので、自動配置は公開領域外に限る。
     * そこへ書けない場合は、黙って公開領域内に逃げずに設定エラーで止める（db_path を明示させる）。
     */
    private static function resolveDbPath(mixed $configured, string $appDir): string
    {
        $siteRoot = dirname($appDir, 1);

        if (is_string($configured) && trim($configured) !== '') {
            $path = trim($configured);
            if ($path === ':memory:') {
                return $path;
            }
            if (!str_starts_with($path, '/')) {
                // 相対パスはサイト直下（公開ディレクトリ内）に置かれる。.htaccess の 403 は
                // Apache には効くが、Nginx が静的ファイルを直接配信する構成では効かず、
                // DB が読まれ得る。動きは変えずに警告だけ出す（黙って危険な場所へ逃げない）。
                error_log(
                    '[aegis] 警告: db_path が相対パスです（' . $path . '）。'
                    . '公開ディレクトリ内（' . $siteRoot . '/' . $path . '）に DB が作られます。'
                    . ' 公開ディレクトリの外の絶対パス（例: ' . dirname($siteRoot, 1)
                    . '/aegis-data/aegis.db）を指定してください。',
                );
                $path = $siteRoot . '/' . $path;
            }
            return $path;
        }

        $documentRoot = $_SERVER['DOCUMENT_ROOT'] ?? '';
        if (is_string($documentRoot) && $documentRoot !== '' && str_starts_with($documentRoot, '/')) {
            // 例: /home/<id>/<domain>/public_html → /home/<id>/<domain>/aegis-data
            $dir = dirname(rtrim($documentRoot, '/')) . '/aegis-data';
            if (self::ensureWritableDir($dir)) {
                return $dir . '/' . basename($siteRoot) . '.db';
            }
        }

        throw new \RuntimeException(
            'データベースの保存先を確保できません。公開ディレクトリの外（例: ' . dirname($siteRoot, 1)
            . '/aegis-data/aegis.db）を aegis-config.php の db_path に指定してください。'
            . ' 詳しくは deploy/xserver/README.md の「設定」を参照してください。',
        );
    }

    private static function ensureWritableDir(string $dir): bool
    {
        if (is_dir($dir)) {
            return is_writable($dir);
        }
        if (!@mkdir($dir, 0700, true) && !is_dir($dir)) {
            return false;
        }
        @chmod($dir, 0700);
        return is_writable($dir);
    }

    private static function envBool(string $raw): ?bool
    {
        return match (strtolower(trim($raw))) {
            '1', 'true', 'on', 'yes' => true,
            '0', 'false', 'off', 'no' => false,
            default => null,
        };
    }

    private static function envNullableBool(string $raw): ?bool
    {
        $value = strtolower(trim($raw));
        if ($value === 'auto') {
            return null;
        }
        return self::envBool($raw);
    }

    private static function envInt(string $raw): ?int
    {
        return preg_match('/^\s*-?\d+\s*$/', $raw) === 1 ? (int) trim($raw) : null;
    }

    private static function nullableBool(mixed $value): ?bool
    {
        if (is_bool($value)) {
            return $value;
        }
        if (is_string($value)) {
            return self::envNullableBool($value);
        }
        return null;
    }

    private static function nullableString(mixed $value): ?string
    {
        return is_string($value) ? trim($value) : null;
    }

    private static function intValue(mixed $value, int $fallback): int
    {
        if (is_int($value)) {
            return $value;
        }
        if (is_string($value) && preg_match('/^\s*-?\d+\s*$/', $value) === 1) {
            return (int) trim($value);
        }
        if (is_float($value) && is_finite($value)) {
            return (int) $value;
        }
        return $fallback;
    }

    private static function positiveInt(mixed $value, int $fallback): int
    {
        $int = self::intValue($value, $fallback);
        return $int > 0 ? $int : $fallback;
    }
}
