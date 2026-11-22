<?php
/**
 * セキュリティヘッダ。内容は server/middleware/security.ts と同一に保つ。
 *
 * サイト直下の .htaccess も静的ファイル向けに同じヘッダを付ける。
 * 値が食い違わないよう、変更するときは両方とテストを更新する
 * （deploy/xserver/tests/api-compat.php が CSP の一致を検査する）。
 */

declare(strict_types=1);

namespace Zekey;

final class Security
{
    public const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        . "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; "
        . "worker-src 'self' blob:; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; "
        . "form-action 'self'; object-src 'none'";

    public const PERMISSIONS_POLICY = 'camera=(self), microphone=(), geolocation=(), interest-cohort=()';

    /**
     * 全レスポンスに付けるヘッダ。
     *
     * @return array<string, string>
     */
    public static function headers(bool $https, string $path): array
    {
        $headers = [
            'Content-Security-Policy' => self::CSP,
            'X-Content-Type-Options' => 'nosniff',
            'Referrer-Policy' => 'no-referrer',
            'X-Frame-Options' => 'DENY',
            'Permissions-Policy' => self::PERMISSIONS_POLICY,
            'Cross-Origin-Opener-Policy' => 'same-origin',
            'Cross-Origin-Resource-Policy' => 'same-origin',
        ];
        if ($https) {
            $headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
        }
        if (str_starts_with($path, '/api/')) {
            $headers['Cache-Control'] = 'no-store';
        }
        return $headers;
    }
}
