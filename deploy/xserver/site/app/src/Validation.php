<?php
/**
 * リクエストボディの検証。server/routes/vault.ts の zod スキーマを同じ規則で再現する。
 *
 * - 未知のキーは strict でエラー（ルートは issues に空文字、envelope は "envelope"）
 * - 数値は JSON の number のみ（文字列からの変換はしない）。整数かつ範囲内であること
 * - 文字列は長さ 1〜N（N は UTF-16 の符号単位で数える。JS の String#length と同じ）
 * - kdf / wrappedKey / data は非 strict なので未知キーは黙って捨てる（Node 版と同じ）
 *
 * issues は zod の error.issues[].path.join('.') に合わせた文字列の配列。
 */

declare(strict_types=1);

namespace Aegis;

use stdClass;

final class Validation
{
    public const MIN_KDF_ITERATIONS = 100000;
    public const MAX_KDF_ITERATIONS = 1000000;
    public const MAX_IV_LENGTH = 64;
    public const MAX_CIPHERTEXT_LENGTH = 200000;
    public const MAX_VERIFIER_LENGTH = 64;
    public const MAX_UPDATED_AT_LENGTH = 64;
    public const MAX_SALT_LENGTH = 64;

    /**
     * PUT /api/vault/:id のボディ `{ envelope, revision }`。
     *
     * @return array{value: array{envelope: array<string, mixed>, revision: int}|null, issues: list<string>}
     */
    public static function putBody(mixed $input): array
    {
        if (!$input instanceof stdClass) {
            // zod: ルートがオブジェクトでない（path は []）
            return ['value' => null, 'issues' => ['']];
        }

        $issues = [];
        $envelope = self::envelope($input, $issues);
        $revision = self::intField($input, 'revision', 'revision', 0, null, $issues);

        foreach (array_keys(get_object_vars($input)) as $key) {
            if ($key !== 'envelope' && $key !== 'revision') {
                $issues[] = '';
            }
        }

        if ($issues !== [] || $envelope === null || $revision === null) {
            return ['value' => null, 'issues' => $issues];
        }

        return ['value' => ['envelope' => $envelope, 'revision' => $revision], 'issues' => []];
    }

    /**
     * @param list<string> $issues
     * @return array<string, mixed>|null
     */
    private static function envelope(stdClass $root, array &$issues): ?array
    {
        $before = count($issues);
        if (!property_exists($root, 'envelope')) {
            $issues[] = 'envelope';
            return null;
        }
        $env = $root->envelope;
        if (!$env instanceof stdClass) {
            $issues[] = 'envelope';
            return null;
        }

        $normalized = [];

        $format = property_exists($env, 'format') ? $env->format : null;
        if ($format !== 'aegis-vault') {
            $issues[] = 'envelope.format';
        }
        $normalized['format'] = 'aegis-vault';

        $version = property_exists($env, 'version') ? $env->version : null;
        if (!self::isInteger($version) || (int) $version !== 1) {
            $issues[] = 'envelope.version';
        }
        $normalized['version'] = 1;

        $normalized['kdf'] = self::kdf($env, $issues);
        $normalized['wrappedKey'] = self::cipher($env, 'wrappedKey', $issues);
        $normalized['data'] = self::cipher($env, 'data', $issues);

        $normalized['verifier'] = self::stringField(
            $env,
            'verifier',
            'envelope.verifier',
            1,
            self::MAX_VERIFIER_LENGTH,
            $issues,
        );
        $normalized['revision'] = self::intField($env, 'revision', 'envelope.revision', 0, null, $issues);
        $normalized['updatedAt'] = self::stringField(
            $env,
            'updatedAt',
            'envelope.updatedAt',
            1,
            self::MAX_UPDATED_AT_LENGTH,
            $issues,
        );

        foreach (array_keys(get_object_vars($env)) as $key) {
            if (!in_array($key, [
                'format',
                'version',
                'kdf',
                'wrappedKey',
                'data',
                'verifier',
                'revision',
                'updatedAt',
            ], true)) {
                $issues[] = 'envelope';
            }
        }

        if (count($issues) !== $before) {
            return null;
        }

        /** @var array<string, mixed> $normalized */
        return $normalized;
    }

    /**
     * @param list<string> $issues
     * @return array{name: string, iterations: int, salt: string}|null
     */
    private static function kdf(stdClass $env, array &$issues): ?array
    {
        $before = count($issues);
        if (!property_exists($env, 'kdf') || !$env->kdf instanceof stdClass) {
            $issues[] = 'envelope.kdf';
            return null;
        }
        /** @var stdClass $kdf */
        $kdf = $env->kdf;

        $name = property_exists($kdf, 'name') ? $kdf->name : null;
        if ($name !== 'PBKDF2-SHA256') {
            $issues[] = 'envelope.kdf.name';
        }
        $iterations = self::intField(
            $kdf,
            'iterations',
            'envelope.kdf.iterations',
            self::MIN_KDF_ITERATIONS,
            self::MAX_KDF_ITERATIONS,
            $issues,
        );
        $salt = self::stringField($kdf, 'salt', 'envelope.kdf.salt', 1, self::MAX_SALT_LENGTH, $issues);

        if (count($issues) !== $before) {
            return null;
        }

        return ['name' => 'PBKDF2-SHA256', 'iterations' => (int) $iterations, 'salt' => (string) $salt];
    }

    /**
     * @param list<string> $issues
     * @return array{iv: string, ciphertext: string}|null
     */
    private static function cipher(stdClass $env, string $key, array &$issues): ?array
    {
        $path = 'envelope.' . $key;
        $before = count($issues);
        if (!property_exists($env, $key) || !$env->{$key} instanceof stdClass) {
            $issues[] = $path;
            return null;
        }
        /** @var stdClass $object */
        $object = $env->{$key};

        $iv = self::stringField($object, 'iv', $path . '.iv', 1, self::MAX_IV_LENGTH, $issues);
        $ciphertext = self::stringField(
            $object,
            'ciphertext',
            $path . '.ciphertext',
            1,
            self::MAX_CIPHERTEXT_LENGTH,
            $issues,
        );

        if (count($issues) !== $before) {
            return null;
        }

        return ['iv' => (string) $iv, 'ciphertext' => (string) $ciphertext];
    }

    /**
     * @param list<string> $issues
     */
    private static function stringField(
        stdClass $object,
        string $key,
        string $path,
        int $min,
        int $max,
        array &$issues,
    ): ?string {
        if (!property_exists($object, $key)) {
            $issues[] = $path;
            return null;
        }
        $value = $object->{$key};
        if (!is_string($value)) {
            $issues[] = $path;
            return null;
        }
        $length = self::stringLength($value);
        if ($length < $min || $length > $max) {
            $issues[] = $path;
            return null;
        }
        return $value;
    }

    /**
     * @param list<string> $issues
     */
    private static function intField(
        stdClass $object,
        string $key,
        string $path,
        ?int $min,
        ?int $max,
        array &$issues,
    ): ?int {
        if (!property_exists($object, $key)) {
            $issues[] = $path;
            return null;
        }
        $value = $object->{$key};
        if (!self::isInteger($value)) {
            $issues[] = $path;
            return null;
        }
        $int = (int) $value;
        if (($min !== null && $int < $min) || ($max !== null && $int > $max)) {
            $issues[] = $path;
            return null;
        }
        return $int;
    }

    /** JSON の number かつ整数（JS の Number.isInteger と同じ扱い）。 */
    private static function isInteger(mixed $value): bool
    {
        if (is_int($value)) {
            return true;
        }
        if (!is_float($value) || !is_finite($value)) {
            return false;
        }
        return floor($value) === $value && abs($value) <= 9007199254740991.0;
    }

    /** JS の String#length（UTF-16 の符号単位）に合わせた長さ。 */
    private static function stringLength(string $value): int
    {
        if ($value === '') {
            return 0;
        }
        if (function_exists('mb_convert_encoding')) {
            $utf16 = @mb_convert_encoding($value, 'UTF-16LE', 'UTF-8');
            if (is_string($utf16)) {
                return intdiv(strlen($utf16), 2);
            }
        }
        return strlen($value);
    }
}
