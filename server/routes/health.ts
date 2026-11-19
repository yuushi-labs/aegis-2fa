import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { AegisDatabase } from '../db/client';

export type HealthOptions = {
  db: AegisDatabase;
  version: string;
};

export function createHealthRoutes(options: HealthOptions): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    let database: 'ok' | 'error' = 'ok';
    try {
      await options.db.get(sql`select 1`);
    } catch {
      database = 'error';
    }
    const status = database === 'ok' ? 'ok' : 'degraded';
    return c.json(
      {
        status,
        uptime: Math.round(process.uptime()),
        version: options.version,
        database,
      },
      database === 'ok' ? 200 : 503,
    );
  });

  return app;
}
