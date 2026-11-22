<?php
/**
 * リクエストの取り出し。Hono の c.req 相当（必要な情報だけ）。
 */

declare(strict_types=1);

namespace Zekey;

final class Request
{
    /** php://input は 1 回しか読めないので、読んだ結果を保持する。 */
    private static ?string $cachedBody = null;
    private static bool $bodyTooLarge = false;

    /**
     * @param array<string, string> $headers 小文字のヘッダ名 → 値
     */
    private function __construct(
        public readonly string $method,
        public readonly string $path,
        public readonly ?string $remoteAddr,
        private readonly array $headers,
        public readonly bool $isHttps,
    ) {
    }

    public static function fromGlobals(): self
    {
        $method = strtoupper(self::serverString('REQUEST_METHOD') ?? 'GET');
        $uri = self::serverString('REQUEST_URI') ?? '/';

        $path = parse_url($uri, PHP_URL_PATH);
        if (!is_string($path) || $path === '') {
            $path = '/';
        }

        // サイトがサブディレクトリ（例: /zekey/）に置かれていても
        // .htaccess 経由の REQUEST_URI はサイト基準に直す。
        $base = self::appBase(self::serverString('SCRIPT_NAME') ?? '');
        if ($base !== '' && ($path === $base || str_starts_with($path, $base . '/'))) {
            $path = substr($path, strlen($base));
        }

        return new self(
            $method,
            self::normalizePath($path),
            self::serverString('REMOTE_ADDR'),
            self::readHeaders(),
            self::detectHttps(),
        );
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    /**
     * php://input を上限付きで読み切る。
     *
     * @return array{body: string, tooLarge: bool}
     */
    public static function readBody(int $maxBytes): array
    {
        if (self::$cachedBody !== null) {
            return ['body' => self::$cachedBody, 'tooLarge' => self::$bodyTooLarge];
        }

        $stream = @fopen('php://input', 'rb');
        if ($stream === false) {
            self::$cachedBody = '';
            return ['body' => '', 'tooLarge' => false];
        }

        $body = '';
        $total = 0;
        try {
            while (!feof($stream)) {
                $chunk = fread($stream, 8192);
                if ($chunk === false || $chunk === '') {
                    break;
                }
                $total += strlen($chunk);
                if ($total > $maxBytes) {
                    // 上限を超えた時点で打ち切る（読み残しは保持しない）。
                    self::$cachedBody = '';
                    self::$bodyTooLarge = true;
                    return ['body' => '', 'tooLarge' => true];
                }
                $body .= $chunk;
            }
        } finally {
            fclose($stream);
        }

        self::$cachedBody = $body;
        self::$bodyTooLarge = false;
        return ['body' => $body, 'tooLarge' => false];
    }

    /** スクリプトの配置（/zekey/api/index.php）からサイトの基準パス（/zekey）を求める。 */
    private static function appBase(string $scriptName): string
    {
        if ($scriptName === '') {
            return '';
        }
        $base = dirname(dirname($scriptName));
        if ($base === '/' || $base === '.' || $base === '\\') {
            return '';
        }
        return rtrim($base, '/');
    }

    /** 末尾スラッシュを落とす（Hono の既定 strict=false と同じ扱い）。 */
    private static function normalizePath(string $path): string
    {
        if ($path === '') {
            return '/';
        }
        if (!str_starts_with($path, '/')) {
            $path = '/' . $path;
        }
        $trimmed = rtrim($path, '/');
        return $trimmed === '' ? '/' : $trimmed;
    }

    /** @return array<string, string> */
    private static function readHeaders(): array
    {
        $headers = [];
        foreach ($_SERVER as $key => $value) {
            if (!is_string($key) || !is_string($value) || !str_starts_with($key, 'HTTP_')) {
                continue;
            }
            $headers[strtolower(str_replace('_', '-', substr($key, 5)))] = $value;
        }

        // Apache の [E=HTTP_AUTHORIZATION:...] は REDIRECT_ 付きで届くことがある。
        $redirectAuth = self::serverString('REDIRECT_HTTP_AUTHORIZATION');
        if ($redirectAuth !== null && !isset($headers['authorization'])) {
            $headers['authorization'] = $redirectAuth;
        }

        $contentType = self::serverString('CONTENT_TYPE');
        if ($contentType !== null && !isset($headers['content-type'])) {
            $headers['content-type'] = $contentType;
        }
        $contentLength = self::serverString('CONTENT_LENGTH');
        if ($contentLength !== null && !isset($headers['content-length'])) {
            $headers['content-length'] = $contentLength;
        }

        if (function_exists('getallheaders')) {
            $all = getallheaders();
            if (is_array($all)) {
                foreach ($all as $name => $value) {
                    if (is_string($name) && is_string($value)) {
                        $headers[strtolower($name)] = $value;
                    }
                }
            }
        }

        return $headers;
    }

    private static function detectHttps(): bool
    {
        $https = self::serverString('HTTPS');
        if ($https !== null && $https !== '' && strtolower($https) !== 'off') {
            return true;
        }
        $port = self::serverString('SERVER_PORT');
        return $port === '443';
    }

    private static function serverString(string $key): ?string
    {
        $value = $_SERVER[$key] ?? null;
        return is_string($value) ? $value : null;
    }
}
