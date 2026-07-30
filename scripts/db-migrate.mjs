import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run migrations.");
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
});

const migrationsDir = path.join(process.cwd(), "db", "migrations");
const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

function checksum(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT");

  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    const digest = checksum(sql);
    const existing = await client.query(
      "SELECT checksum FROM schema_migrations WHERE name = $1",
      [file]
    );
    if (existing.rowCount) {
      const appliedChecksum = existing.rows[0].checksum;
      if (appliedChecksum && appliedChecksum !== digest) {
        throw new Error(`Migration checksum mismatch: ${file}. Create a new migration instead of editing an applied migration.`);
      }
      if (!appliedChecksum) {
        await client.query("UPDATE schema_migrations SET checksum = $2 WHERE name = $1", [file, digest]);
      }
      continue;
    }
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations(name, checksum) VALUES($1, $2)", [file, digest]);
    process.stdout.write(`[db:migrate] applied ${file}\n`);
  }

  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
