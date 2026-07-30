import { Pool, PoolClient, QueryResultRow } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __sceneCartPgPool: Pool | undefined;
}

export function isPostgresRuntimeEnabled() {
  return process.env.RUNTIME_STORE === "postgres";
}

export function getDatabasePool() {
  if (!isPostgresRuntimeEnabled()) {
    throw new Error("PostgreSQL runtime is disabled. Set RUNTIME_STORE=postgres to enable it.");
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required when RUNTIME_STORE=postgres.");
  }

  if (!globalThis.__sceneCartPgPool) {
    globalThis.__sceneCartPgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
    });
  }

  return globalThis.__sceneCartPgPool;
}

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  return getDatabasePool().query<T>(text, values);
}

export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const value = await callback(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
