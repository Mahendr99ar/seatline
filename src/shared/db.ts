import pg from "pg";

// Postgres numeric types we use are all small enough for a JS number.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function connect(url: string, max = 10): Db {
  return new pg.Pool({ connectionString: url, max });
}

export async function tx<T>(db: Db, fn: (c: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Applies numbered schema steps once each. An advisory lock keeps two
 * replicas starting at the same time from running the same step twice.
 */
export async function migrate(db: Db, steps: string[]): Promise<void> {
  await tx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(7301)");
    await c.query("CREATE TABLE IF NOT EXISTS schema_version (version int NOT NULL)");
    const { rows } = await c.query<{ version: number }>("SELECT version FROM schema_version");
    let current = rows[0]?.version ?? 0;
    if (rows.length === 0) await c.query("INSERT INTO schema_version VALUES (0)");
    for (; current < steps.length; current++) {
      await c.query(steps[current]!);
    }
    await c.query("UPDATE schema_version SET version = $1", [current]);
  });
}
