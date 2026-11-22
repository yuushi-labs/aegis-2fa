<?php
/**
 * 設定の読み込み。既定値（config.php）→ 設定ファイル → 環境変数の順で上書きする。
 *
 * Xserver の共用サーバーでは環境変数を自由に置けないことが多いため、
 * 実運用では公開ディレクトリ外の zekey-config.php を使うのが確実。
 */

declare(strict_types=1);

namespace Zekey;

final class Config
{
    /** 転送ヘッダを信じてよい接続元の既定値（同じホストで動く前段プロキシ）。 */
    public const DEFAULT_TRUST_PROXY_IPS = ['127.0.0.1', '::1'];

    private function __construct(
        public readonly string $dbPath,
        public readonly int $maxVaultBytes,
        public readonly ?string $corsOrigin,
        public readonly bool $trustProxy,
        public readonly int $trustProxyHops,
        /** X-Forwarded-For を信じてよい接続元（プロキシ）の IP。 */
        public readonly array $trustProxyIps,
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
            trustProxyIps: self::ipList($values['trust_proxy_ips'] ?? self::DEFAULT_TRUST_PROXY_IPS),
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
     * X-Forwarded-For を信じてよい接続元か。
     *
     * trust_proxy は「前段が転送ヘッダを上書きする」前提の設定なので、接続元が
     * その前段（既定では同じホストのプロキシ）であることも確かめる。直接つながる
     * クライアントが X-Forwarded-For を毎回変えてレート制限を回避できないようにするため。
     */
    public function isTrustedProxy(?string $remoteAddr): bool
    {
        if ($remoteAddr === null || $remoteAddr === '') {
            return false;
        }
        $normalized = str_starts_with($remoteAddr, '::ffff:') ? substr($remoteAddr, 7) : $remoteAddr;
        foreach ($this->trustProxyIps as $trusted) {
            if ($trusted === $remoteAddr || $trusted === $normalized) {
                return true;
            }
        }
        return false;
    }

    /**
     * IP の一覧（配列またはカンマ区切り）を正規化する。IP として不正な値は捨てる。
     *
     * @return list<string>
     */
    private static function ipList(mixed $value): array
    {
        $items = [];
        foreach (is_array($value) ? $value : [$value] as $entry) {
            if (!is_string($entry)) {
                continue;
            }
            foreach (preg_split('/[\s,]+/', $entry) ?: [] as $item) {
                if (filter_var($item, FILTER_VALIDATE_IP) !== false) {
                    $items[$item] = true;
                }
            }
        }
        return array_keys($items);
    }

    /**
     * 設定ファイルの候補（先に見つかったものだけ読む）。
     *
     * @return list<string>
     */
    private static function configFiles(string $appDir): array
    {
        $candidates = [];
        $explicit = getenv('ZEKEY_CONFIG');
        if (is_string($explicit) && $explicit !== '') {
            $candidates[] = $explicit;
        }
        // 推奨: 公開ディレクトリの 1 つ上（例: /home/<id>/<domain>/zekey-config.php）。
        $documentRoot = $_SERVER['DOCUMENT_ROOT'] ?? '';
        if (is_string($documentRoot) && $documentRoot !== '' && str_starts_with($documentRoot, '/')) {
            $candidates[] = dirname(rtrim($documentRoot, '/')) . '/zekey-config.php';
        }
        // DOCUMENT_ROOT が無い環境（CLI など）向けの保険。
        $candidates[] = dirname($appDir, 3) . '/zekey-config.php';
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
            'ZEKEY_DB_PATH' => 'db_path',
            'ZEKEY_MAX_VAULT_BYTES' => 'max_vault_bytes',
            'ZEKEY_CORS_ORIGIN' => 'cors_origin',
            'ZEKEY_TRUST_PROXY' => 'trust_proxy',
            'ZEKEY_TRUST_PROXY_HOPS' => 'trust_proxy_hops',
            'ZEKEY_TRUST_PROXY_IPS' => 'trust_proxy_ips',
            'ZEKEY_HTTPS' => 'https',
            'ZEKEY_RATE_LIMIT' => 'rate_limit',
            'ZEKEY_RATE_LIMIT_READ_MAX' => 'rate_limit_read_max',
            'ZEKEY_RATE_LIMIT_WRITE_MAX' => 'rate_limit_write_max',
            'ZEKEY_RATE_LIMIT_WINDOW' => 'rate_limit_window_seconds',
            'ZEKEY_RATE_LIMIT_CREATE_MAX' => 'rate_limit_create_max',
            'ZEKEY_RATE_LIMIT_CREATE_WINDOW' => 'rate_limit_create_window_seconds',
            'ZEKEY_DEBUG' => 'debug',
            'ZEKEY_VERSION' => 'version',
        ];

        $overrides = [];
        foreach ($map as $env => $key) {
            $raw = getenv($env);
            if (!is_string($raw) || $raw === '') {
                continue;
            }
            $overrides[$key] = match ($key) {
                'db_path', 'cors_origin', 'version', 'trust_proxy_ips' => $raw,
                'trust_proxy', 'rate_limit', 'debug' => self::envBool($raw),
                'https' => self::envNullableBool($raw),
                default => self::envInt($raw),
            };
        }
        return $overrides;
    }

    /** 新しい DB の既定ディレクトリ（DOCUMENT_ROOT の親に作る）。 */
    private const DATA_DIR = 'zekey-data';

    /** 新しい DB のファイル名。 */
    private const DB_FILE = 'zekey.db';

    /**
     * 旧名（Aegis 2FA / `/aegis/` 配信）時代の DB。
     *
     * WebFTP では `public_html` の外を手でリネームできないことがあるため、
     * ディレクトリ名は変えずに読み取り元としてだけ扱い、初回起動時に新しい場所へ写す。
     */
    private const LEGACY_DATA_DIR = 'aegis-data';
    private const LEGACY_DB_FILE = 'aegis.db';

    /**
     * DB の場所。既定では公開ディレクトリの**外**に作る。
     *
     * Xserver は Nginx が静的ファイルを直接配信することがあり、その場合 `.htaccess` の 403 は
     * 効かない。DB を公開ディレクトリ内（storage/ など）に自動で置くと、暗号文と token_hash が
     * `GET /<site>/storage/zekey.db` で読めてしまう構成になり得るので、自動配置は公開領域外に限る。
     * そこへ書けない場合は、黙って公開領域内に逃げずに設定エラーで止める（db_path を明示させる）。
     *
     * 旧 `/aegis/` の DB（`aegis-data/aegis.db`）が残っていて新しい場所にまだ DB が無い場合は、
     * 中身を写してから新しい場所を使う（利用者のボルトを失わない）。写せない環境では、
     * 上書きも削除もしないまま旧 DB をそのまま使い続ける。
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
                    '[zekey] 警告: db_path が相対パスです（' . $path . '）。'
                    . '公開ディレクトリ内（' . $siteRoot . '/' . $path . '）に DB が作られます。'
                    . ' 公開ディレクトリの外の絶対パス（例: ' . dirname($siteRoot, 1)
                    . '/zekey-data/zekey.db）を指定してください。',
                );
                $path = $siteRoot . '/' . $path;
            }
            return $path;
        }

        $documentRoot = $_SERVER['DOCUMENT_ROOT'] ?? '';
        if (is_string($documentRoot) && $documentRoot !== '' && str_starts_with($documentRoot, '/')) {
            // 例: /home/<id>/<domain>/public_html → /home/<id>/<domain>/zekey-data/zekey.db
            $base = dirname(rtrim($documentRoot, '/'));
            $target = $base . '/' . self::DATA_DIR . '/' . self::DB_FILE;
            if (is_file($target)) {
                return $target;
            }

            $legacy = $base . '/' . self::LEGACY_DATA_DIR . '/' . self::LEGACY_DB_FILE;
            if (is_file($legacy)) {
                if (self::migrateLegacyDatabase($legacy, $target)) {
                    return $target;
                }
                error_log(
                    '[zekey] 警告: 旧 DB（' . $legacy . '）を ' . $target . ' へ写せませんでした。'
                    . '旧 DB をそのまま使います（データは変更していません）。',
                );
                return $legacy;
            }

            if (self::ensureWritableDir(dirname($target))) {
                return $target;
            }
        }

        throw new \RuntimeException(
            'データベースの保存先を確保できません。公開ディレクトリの外（例: ' . dirname($siteRoot, 1)
            . '/zekey-data/zekey.db）を zekey-config.php の db_path に指定してください。'
            . ' 詳しくは deploy/xserver/README.md の「設定」を参照してください。',
        );
    }

    /**
     * 旧 DB を新しい場所へ写す。成功したら true（旧 DB はそのまま残す）。
     *
     * 旧 `/aegis/` を開いたままでも時点が混ざらないよう、SQLite の `VACUUM INTO` で
     * 一貫したスナップショットを作るのを優先する（WAL の未チェックポイント分も含む）。
     * それが使えない環境では、DB ファイルと `-wal` / `-shm` をコピーする。
     */
    private static function migrateLegacyDatabase(string $legacy, string $target): bool
    {
        if (!self::ensureWritableDir(dirname($target))) {
            return false;
        }
        // 別のリクエストが先に写し終えていれば、それをそのまま使う。
        if (is_file($target)) {
            return true;
        }

        if (self::snapshotDatabase($legacy, $target)) {
            return true;
        }

        if (!@copy($legacy, $target)) {
            return false;
        }
        foreach (['-wal', '-shm'] as $suffix) {
            if (is_file($legacy . $suffix)) {
                @copy($legacy . $suffix, $target . $suffix);
            }
        }
        @chmod($target, 0600);
        return true;
    }

    /**
     * `VACUUM INTO` で一貫したコピーを作り、完成してから本来の名前へ置く。
     * 途中で失敗しても、半端なファイルを DB として残さない。
     */
    private static function snapshotDatabase(string $source, string $target): bool
    {
        $temporary = $target . '.migrating-' . bin2hex(random_bytes(6));
        try {
            $pdo = new \PDO('sqlite:' . $source, null, null, [
                \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
            ]);
            $pdo->exec('PRAGMA busy_timeout = 5000');
            $pdo->exec('VACUUM INTO ' . $pdo->quote($temporary));
            $pdo = null;
            @chmod($temporary, 0600);
            if (!@rename($temporary, $target)) {
                @unlink($temporary);
                return false;
            }
            return true;
        } catch (\Throwable $error) {
            @unlink($temporary);
            error_log(
                '[zekey] 旧 DB のスナップショット作成に失敗しました（ファイルコピーで再試行）: '
                . $error->getMessage(),
            );
            return false;
        }
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
