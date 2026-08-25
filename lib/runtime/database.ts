import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, PoolClient, QueryResultRow } from "pg";
import { databaseSslConfig } from "@/lib/runtime/database-ssl";

declare global {
  var __sceneCartPgPool: Pool | undefined;
  var __sceneCartLocalWorkflowLocks: Map<string, Promise<void>> | undefined;
}

const databaseClientContext = new AsyncLocalStorage<PoolClient>();
const localWorkflowLockContext = new AsyncLocalStorage<Set<string>>();
const localWorkflowLocks = globalThis.__sceneCartLocalWorkflowLocks ?? new Map<string, Promise<void>>();
globalThis.__sceneCartLocalWorkflowLocks = localWorkflowLocks;

function localWorkflowLockKey(sessionId: string) {
  return `scenecart:workflow:${sessionId}`;
}

function holdsLocalWorkflowLock(key: string) {
  return localWorkflowLockContext.getStore()?.has(key) === true;
}

function runWithLocalWorkflowLockContext<T>(key: string, callback: () => Promise<T>) {
  const existing = localWorkflowLockContext.getStore();
  if (existing?.has(key)) return callback();
  const held = new Set(existing ?? []);
  held.add(key);
  return localWorkflowLockContext.run(held, callback);
}

function reserveLocalWorkflowLock(key: string) {
  const predecessor = (localWorkflowLocks.get(key) ?? Promise.resolve()).catch(() => undefined);
  let releaseSlot!: () => void;
  const slot = new Promise<void>((resolve) => {
    releaseSlot = resolve;
  });
  const tail = predecessor.then(() => slot);
  localWorkflowLocks.set(key, tail);

  let released = false;
  return {
    ready: predecessor,
    release(acquired: boolean) {
      if (released) return;
      released = true;
      releaseSlot();
      if (acquired && localWorkflowLocks.get(key) === tail) {
        localWorkflowLocks.delete(key);
        return;
      }
      void tail.finally(() => {
        if (localWorkflowLocks.get(key) === tail) {
          localWorkflowLocks.delete(key);
        }
      });
    }
  };
}

async function waitForLocalWorkflowLock(ready: Promise<void>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`workflow session lock timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
      ssl: databaseSslConfig()
    });
  }

  return globalThis.__sceneCartPgPool;
}

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  const client = databaseClientContext.getStore();
  return client
    ? client.query<T>(text, values)
    : getDatabasePool().query<T>(text, values);
}

export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>) {
  const existingClient = databaseClientContext.getStore();
  if (existingClient) {
    return callback(existingClient);
  }

  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const value = await databaseClientContext.run(client, () => callback(client));
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function withDatabaseAdvisoryLock<T>(
  key: string,
  callback: () => Promise<T>
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  return withTransaction(async (client) => {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
      [key]
    );
    if (result.rows[0]?.acquired !== true) return { acquired: false };
    return { acquired: true, value: await callback() };
  });
}

export async function withDatabaseAdvisoryLockWait<T>(
  key: string,
  callback: () => Promise<T>,
  timeoutMs = 5_000
): Promise<T> {
  return withTransaction(async (client) => {
    await client.query("SELECT set_config('lock_timeout', $1, true)", [
      `${Math.max(250, Math.floor(timeoutMs))}ms`
    ]);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [key]
    );
    return callback();
  });
}

export async function withWorkflowSessionLock<T>(sessionId: string, callback: () => Promise<T>) {
  if (!isPostgresRuntimeEnabled()) {
    const key = localWorkflowLockKey(sessionId);
    if (holdsLocalWorkflowLock(key)) {
      return { acquired: true as const, value: await callback() };
    }
    if (localWorkflowLocks.has(key)) return { acquired: false as const };

    const reservation = reserveLocalWorkflowLock(key);
    await reservation.ready;
    try {
      return {
        acquired: true as const,
        value: await runWithLocalWorkflowLockContext(key, callback)
      };
    } finally {
      reservation.release(true);
    }
  }
  return withDatabaseAdvisoryLock(`scenecart:workflow:${sessionId}`, callback);
}

export async function withWorkflowSessionTransaction<T>(
  sessionId: string,
  callback: () => Promise<T>,
  timeoutMs = 5_000
) {
  if (!isPostgresRuntimeEnabled()) {
    const key = localWorkflowLockKey(sessionId);
    if (holdsLocalWorkflowLock(key)) return callback();

    const reservation = reserveLocalWorkflowLock(key);
    let acquired = false;
    try {
      await waitForLocalWorkflowLock(reservation.ready, timeoutMs);
      acquired = true;
      return await runWithLocalWorkflowLockContext(key, callback);
    } finally {
      reservation.release(acquired);
    }
  }
  return withDatabaseAdvisoryLockWait(`scenecart:workflow:${sessionId}`, callback, timeoutMs);
}

export async function closeDatabasePoolForTests() {
  if (!globalThis.__sceneCartPgPool) return;
  const pool = globalThis.__sceneCartPgPool;
  globalThis.__sceneCartPgPool = undefined;
  await pool.end();
}
