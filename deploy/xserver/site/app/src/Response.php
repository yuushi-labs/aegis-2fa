<?php
/**
 * レスポンス。Hono の c.json / c.body 相当。
 */

declare(strict_types=1);

namespace Zekey;

final class Response
{
    /**
     * @param array<string, string> $headers
     */
    public function __construct(
        public readonly int $status,
        public readonly string $body = '',
        public readonly array $headers = [],
    ) {
    }

    public static function json(mixed $data, int $status = 200): self
    {
        $json = json_encode(
            $data,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE,
        );
        if ($json === false) {
            // ここまで来るのは保存データが壊れている場合だけ。本文は出さない。
            return new self(
                500,
                '{"error":"internal_error","message":"internal_error"}',
                ['Content-Type' => 'application/json; charset=UTF-8'],
            );
        }
        return new self($status, $json, ['Content-Type' => 'application/json; charset=UTF-8']);
    }

    /**
     * エラーレスポンス（キーの順序は Node 版と揃える: error が先頭）。
     *
     * @param array<string, mixed> $extra
     */
    public static function error(string $code, int $status, array $extra = []): self
    {
        return self::json(['error' => $code] + $extra, $status);
    }

    public static function noContent(): self
    {
        return new self(204);
    }

    /**
     * @param array<string, string> $headers
     */
    public function withHeaders(array $headers): self
    {
        return new self($this->status, $this->body, $this->headers + $headers);
    }

    public function send(): void
    {
        if (!headers_sent()) {
            http_response_code($this->status);
            foreach ($this->headers as $name => $value) {
                header($name . ': ' . $value, true);
            }
        }
        if ($this->body !== '') {
            echo $this->body;
        }
    }
}
