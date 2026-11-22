<?php
/**
 * PHP 版バックエンドの互換テスト用ヘルパ（外部依存なし）。
 */

declare(strict_types=1);

final class TestClient
{
    private int $passed = 0;
    private int $failed = 0;

    public function __construct(
        private readonly string $baseUrl,
        private readonly string $basePath,
    ) {
    }

    public function url(string $path): string
    {
        return $this->baseUrl . $this->basePath . $path;
    }

    public function section(string $name): void
    {
        fwrite(STDOUT, "\n## " . $name . "\n");
    }

    public function check(string $name, bool $ok, string $detail = ''): void
    {
        if ($ok) {
            $this->passed += 1;
            fwrite(STDOUT, '  ok   ' . $name . "\n");
            return;
        }
        $this->failed += 1;
        fwrite(STDOUT, '  FAIL ' . $name . ($detail === '' ? '' : '  [' . $detail . ']') . "\n");
    }

    /**
     * @param array<string, string> $headers
     * @return array{status: int, headers: array<string, string>, body: string, json: mixed}
     */
    public function request(string $method, string $path, array $headers = [], ?string $body = null): array
    {
        $lines = [];
        foreach ($headers as $name => $value) {
            $lines[] = $name . ': ' . $value;
        }

        $context = stream_context_create([
            'http' => [
                'method' => $method,
                'header' => implode("\r\n", $lines),
                'content' => $body ?? '',
                'ignore_errors' => true,
                'follow_location' => 0,
                'timeout' => 10,
                'protocol_version' => 1.1,
            ],
        ]);

        $http_response_header = [];
        $responseBody = @file_get_contents($this->url($path), false, $context);
        $rawHeaders = $http_response_header;

        return self::parseHead($rawHeaders, is_string($responseBody) ? $responseBody : '');
    }

    /**
     * Transfer-Encoding: chunked で送る（Content-Length の無い本文の上限検査用）。
     *
     * @param array<string, string> $headers
     * @return array{status: int, headers: array<string, string>, body: string, json: mixed}
     */
    public function chunked(string $method, string $path, array $headers, string $body): array
    {
        $url = parse_url($this->baseUrl);
        $host = is_array($url) && isset($url['host']) ? (string) $url['host'] : '127.0.0.1';
        $port = is_array($url) && isset($url['port']) ? (int) $url['port'] : 80;

        $socket = @fsockopen($host, $port, $errno, $errstr, 5);
        if ($socket === false) {
            return ['status' => 0, 'headers' => [], 'body' => '', 'json' => null];
        }

        $lines = [
            $method . ' ' . $this->basePath . $path . ' HTTP/1.1',
            'Host: ' . $host . ':' . $port,
            'Connection: close',
            'Transfer-Encoding: chunked',
        ];
        foreach ($headers as $name => $value) {
            $lines[] = $name . ': ' . $value;
        }
        fwrite($socket, implode("\r\n", $lines) . "\r\n\r\n");
        foreach (str_split($body, 16384) as $chunk) {
            fwrite($socket, dechex(strlen($chunk)) . "\r\n" . $chunk . "\r\n");
        }
        fwrite($socket, "0\r\n\r\n");
        $response = (string) stream_get_contents($socket);
        fclose($socket);

        $split = strpos($response, "\r\n\r\n");
        $head = $split === false ? $response : substr($response, 0, $split);
        $rawBody = $split === false ? '' : substr($response, $split + 4);
        $headersRaw = explode("\r\n", $head);
        $statusLine = array_shift($headersRaw) ?? '';

        $parsed = self::parseHead(array_merge([$statusLine], $headersRaw), $rawBody);
        if (isset($parsed['headers']['transfer-encoding'])
            && stripos($parsed['headers']['transfer-encoding'], 'chunked') !== false) {
            $parsed['body'] = self::decodeChunked($parsed['body']);
            $parsed['json'] = json_decode($parsed['body'], true);
        }

        return $parsed;
    }

    public function summary(string $suite): int
    {
        fwrite(STDOUT, "\n" . $suite . ': ' . $this->passed . ' passed, ' . $this->failed . " failed\n");
        return $this->failed === 0 ? 0 : 1;
    }

    /**
     * @param list<string> $rawHeaders
     * @return array{status: int, headers: array<string, string>, body: string, json: mixed}
     */
    private static function parseHead(array $rawHeaders, string $body): array
    {
        $status = 0;
        $headers = [];
        foreach ($rawHeaders as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $matches) === 1) {
                $status = (int) $matches[1];
                $headers = [];
                continue;
            }
            $position = strpos($line, ':');
            if ($position === false) {
                continue;
            }
            $name = strtolower(trim(substr($line, 0, $position)));
            $headers[$name] = trim(substr($line, $position + 1));
        }

        $json = null;
        if ($body !== '') {
            $decoded = json_decode($body, true);
            if (json_last_error() === JSON_ERROR_NONE) {
                $json = $decoded;
            }
        }

        return ['status' => $status, 'headers' => $headers, 'body' => $body, 'json' => $json];
    }

    private static function decodeChunked(string $body): string
    {
        $out = '';
        $offset = 0;
        while (true) {
            $lineEnd = strpos($body, "\r\n", $offset);
            if ($lineEnd === false) {
                break;
            }
            $size = hexdec(substr($body, $offset, $lineEnd - $offset));
            if (!is_int($size) && !is_float($size)) {
                break;
            }
            $size = (int) $size;
            if ($size === 0) {
                break;
            }
            $out .= substr($body, $lineEnd + 2, $size);
            $offset = $lineEnd + 2 + $size + 2;
        }
        return $out;
    }
}

function test_token(): string
{
    return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
}

function test_vault_id(string $token): string
{
    return substr(hash('sha256', $token), 0, 32);
}

function test_bearer(string $token): string
{
    return 'Bearer ' . $token;
}

/**
 * スキーマを満たす封筒（中身は暗号文のふりをしたランダムな base64）。
 *
 * @return array<string, mixed>
 */
function test_envelope(int $revision, ?string $ciphertext = null): array
{
    return [
        'format' => 'aegis-vault',
        'version' => 1,
        'kdf' => [
            'name' => 'PBKDF2-SHA256',
            'iterations' => 600000,
            'salt' => base64_encode(random_bytes(16)),
        ],
        'wrappedKey' => [
            'iv' => base64_encode(random_bytes(12)),
            'ciphertext' => base64_encode(random_bytes(48)),
        ],
        'data' => [
            'iv' => base64_encode(random_bytes(12)),
            'ciphertext' => $ciphertext ?? base64_encode(random_bytes(64)),
        ],
        'verifier' => base64_encode(random_bytes(16)),
        'revision' => $revision,
        'updatedAt' => '2026-01-01T00:00:00.000Z',
    ];
}

/**
 * @param array<string, mixed> $envelope
 */
function test_put_body(array $envelope, int $baseRevision): string
{
    return (string) json_encode(['envelope' => $envelope, 'revision' => $baseRevision]);
}

function test_site_root(): string
{
    $configured = getenv('ZEKEY_TEST_SITE_ROOT');
    if (is_string($configured) && $configured !== '') {
        return $configured;
    }
    return dirname(__DIR__, 2) . '/build/zekey';
}
