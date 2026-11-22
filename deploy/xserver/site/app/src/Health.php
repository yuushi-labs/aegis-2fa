<?php
/**
 * GET /api/health。形は server/routes/health.ts と同じ
 * `{ status, uptime, version, database }`（DB に届かなければ 503 degraded）。
 */

declare(strict_types=1);

namespace Zekey;

final class Health
{
    public static function respond(?Database $database, string $version): Response
    {
        $databaseStatus = 'ok';
        $uptime = 0;

        if ($database === null) {
            $databaseStatus = 'error';
        } else {
            try {
                $database->pdo()->query('select 1')->fetchColumn();
                // PHP には常駐プロセスがないため、DB を作った時刻からの経過秒数を返す
                // （Node 版の process.uptime() と同じ型・桁を保つため）。
                $uptime = max(0, time() - $database->startedAt());
            } catch (\Throwable) {
                $databaseStatus = 'error';
            }
        }

        return Response::json(
            [
                'status' => $databaseStatus === 'ok' ? 'ok' : 'degraded',
                'uptime' => $uptime,
                'version' => $version,
                'database' => $databaseStatus,
            ],
            $databaseStatus === 'ok' ? 200 : 503,
        );
    }
}
