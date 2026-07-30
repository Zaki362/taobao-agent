import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to check the database schema.");
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
});

const requiredTables = [
  "app_users",
  "auth_sessions",
  "shopping_sessions",
  "executor_devices",
  "agent_jobs",
  "execution_events",
  "security_rate_limits"
];
const migrationsDir = path.join(process.cwd(), "db", "migrations");

function checksum(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

try {
  const tableResult = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [requiredTables]
  );
  const existingTables = new Set(tableResult.rows.map((row) => row.table_name));
  const missingTables = requiredTables.filter((table) => !existingTables.has(table));
  if (missingTables.length > 0) {
    throw new Error(`Missing runtime tables: ${missingTables.join(", ")}. Run npm run db:migrate.`);
  }

  const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  const appliedResult = await pool.query("SELECT name, checksum FROM schema_migrations ORDER BY name");
  const applied = new Map(appliedResult.rows.map((row) => [row.name, row.checksum]));
  const pending = [];

  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    const digest = checksum(sql);
    if (!applied.has(file)) {
      pending.push(file);
      continue;
    }
    if (applied.get(file) !== digest) {
      throw new Error(`Migration checksum mismatch: ${file}. Applied migrations must be immutable.`);
    }
  }

  if (pending.length > 0) {
    throw new Error(`Pending migrations: ${pending.join(", ")}. Run npm run db:migrate.`);
  }

  await pool.query("SELECT 1");
  process.stdout.write(`[db:check] healthy; ${files.length} migrations verified; ${requiredTables.length} runtime tables present\n`);
} finally {
  await pool.end();
}
