<?php
/**
 * vaults テーブルへのアクセス。SQL はすべてプリペアドステートメント。
 */

declare(strict_types=1);

namespace Zekey;

use PDO;

final class VaultRepository
{
    public function __construct(private readonly PDO $pdo)
    {
    }

    /**
     * @return array{id: string, token_hash: string, envelope: string, revision: int, created_at: string, updated_at: string}|null
     */
    public function find(string $id): ?array
    {
        $statement = $this->pdo->prepare(
            'SELECT id, token_hash, envelope, revision, created_at, updated_at FROM vaults WHERE id = :id LIMIT 1',
        );
        $statement->execute([':id' => $id]);
        $row = $statement->fetch();

        if (!is_array($row)) {
            return null;
        }

        return [
            'id' => (string) $row['id'],
            'token_hash' => (string) $row['token_hash'],
            'envelope' => (string) $row['envelope'],
            'revision' => (int) $row['revision'],
            'created_at' => (string) $row['created_at'],
            'updated_at' => (string) $row['updated_at'],
        ];
    }

    public function insert(string $id, string $tokenHash, string $envelope, int $revision, string $now): void
    {
        $statement = $this->pdo->prepare(
            'INSERT INTO vaults (id, token_hash, envelope, revision, created_at, updated_at)'
            . ' VALUES (:id, :token_hash, :envelope, :revision, :created_at, :updated_at)',
        );
        $statement->execute([
            ':id' => $id,
            ':token_hash' => $tokenHash,
            ':envelope' => $envelope,
            ':revision' => $revision,
            ':created_at' => $now,
            ':updated_at' => $now,
        ]);
    }

    public function update(string $id, string $envelope, int $revision, string $now): void
    {
        $statement = $this->pdo->prepare(
            'UPDATE vaults SET envelope = :envelope, revision = :revision, updated_at = :updated_at WHERE id = :id',
        );
        $statement->execute([
            ':envelope' => $envelope,
            ':revision' => $revision,
            ':updated_at' => $now,
            ':id' => $id,
        ]);
    }

    public function delete(string $id): void
    {
        $this->pdo->prepare('DELETE FROM vaults WHERE id = :id')->execute([':id' => $id]);
    }

    /** 保存済み暗号文の総量（UTF-8 のバイト数）。SQLite の TEXT 長は文字数なので BLOB として数える。 */
    public function storedBytes(): int
    {
        $total = $this->pdo
            ->query('SELECT coalesce(sum(length(cast(envelope as blob))), 0) AS total FROM vaults')
            ->fetchColumn();

        return is_numeric($total) ? (int) $total : 0;
    }
}
