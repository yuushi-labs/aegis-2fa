<?php
/**
 * SQLite（PDO）の接続とスキーマ。サーバーが持つのは暗号文・ID・版・時刻だけ。
 *
 * スキーマは drizzle/0000_certain_ben_parker.sql と揃えてあるため、Node 版が作った DB を
 * そのまま読むこともできる（列名・型・既定値が同じ）。
 */

declare(strict_types=1);

namespace Zekey;

use PDO;
use RuntimeException;

final class Database
{
    private function __construct(
        private readonly PDO $pdo,
        private readonly string $path,
    ) {
    }

    public static function open(string $path): self
    {
        if ($path !== ':memory:') {
            $dir = dirname($path);
            if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
                throw new RuntimeException('データベースの保存先を作成できません');
            }
        }

        // SQLite は新しいファイルを 0644 で作る。-wal / -shm も含めて作成時から 0600 に
        // するため、作成処理の間だけ umask を絞る（ディレクトリが 0755 でも他ユーザーから読めない）。
        $previousUmask = $path === ':memory:' ? null : umask(0077);
        try {
            $pdo = new PDO('sqlite:' . $path, null, null, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
            ]);
            $pdo->exec('PRAGMA foreign_keys = ON');
            $pdo->exec('PRAGMA busy_timeout = 5000');

            // WAL は DB ごとの設定なので、切り替わっていないときだけ書き込む
            // （毎回 PRAGMA journal_mode=WAL を投げると書き込みロックを取りにいく）。
            $mode = strtolower((string) $pdo->query('PRAGMA journal_mode')->fetchColumn());
            if ($mode !== 'wal' && $path !== ':memory:') {
                $pdo->exec('PRAGMA journal_mode = WAL');
            }

            $database = new self($pdo, $path);
            $database->migrate();
        } finally {
            if ($previousUmask !== null) {
                umask($previousUmask);
            }
        }

        if ($path !== ':memory:' && is_file($path)) {
            // 既存の DB ファイル（作られていた場合）の権限も絞っておく。
            chmod($path, 0600);
        }

        return $database;
    }

    public function pdo(): PDO
    {
        return $this->pdo;
    }

    public function path(): string
    {
        return $this->path;
    }

    /**
     * 読み取りと書き込みをまとめて直列化する即時トランザクション。
     * 楽観ロック（revision の照合）と書き込みの間に別の要求が入らないようにする。
     *
     * @template T
     * @param callable(PDO): T $callback
     * @return T
     */
    public function immediate(callable $callback): mixed
    {
        $this->pdo->exec('BEGIN IMMEDIATE');
        try {
            $result = $callback($this->pdo);
            $this->pdo->exec('COMMIT');
            return $result;
        } catch (\Throwable $error) {
            try {
                $this->pdo->exec('ROLLBACK');
            } catch (\Throwable) {
                // すでに終わっている場合は無視する。
            }
            throw $error;
        }
    }

    /** アプリが最初に DB を作った時刻（PHP には常駐プロセスがないため uptime の基準に使う）。 */
    public function startedAt(): int
    {
        $value = $this->pdo->query("SELECT value FROM app_meta WHERE key = 'started_at'")->fetchColumn();
        if (is_string($value)) {
            $started = (int) $value;
            if ($started > 0) {
                return $started;
            }
        }
        return time();
    }

    private function migrate(): void
    {
        $existing = $this->pdo
            ->query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('vaults', 'rate_limits', 'app_meta')")
            ->fetchAll(PDO::FETCH_COLUMN);
        $tables = array_map(static fn (mixed $name): string => (string) $name, is_array($existing) ? $existing : []);

        if (!in_array('vaults', $tables, true)) {
            $sql = (string) file_get_contents(__DIR__ . '/../schema.sql');
            foreach (explode(';', $sql) as $statement) {
                $statement = trim($statement);
                if ($statement !== '') {
                    $this->pdo->exec($statement);
                }
            }
        }

        // レート制限とメタ情報は PHP 版だけが使う（Node 版の DB に足しても害はない）。
        if (!in_array('rate_limits', $tables, true)) {
            $this->pdo->exec(
                'CREATE TABLE IF NOT EXISTS rate_limits ('
                . ' key TEXT PRIMARY KEY NOT NULL,'
                . ' count INTEGER NOT NULL DEFAULT 0,'
                . ' reset_at INTEGER NOT NULL'
                . ')',
            );
        }
        if (!in_array('app_meta', $tables, true)) {
            $this->pdo->exec(
                'CREATE TABLE IF NOT EXISTS app_meta ('
                . ' key TEXT PRIMARY KEY NOT NULL,'
                . ' value TEXT NOT NULL'
                . ')',
            );
            $this->pdo
                ->prepare('INSERT INTO app_meta (key, value) VALUES (\'started_at\', :value)')
                ->execute([':value' => (string) time()]);
        }
    }
}
