import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("production build migration gate", () => {
  it("keeps database mutations out of the Next.js build phase", () => {
    const buildScript = fs.readFileSync(new URL("../../scripts/build.mjs", import.meta.url), "utf8");
    expect(buildScript).not.toContain("db-migrate.mjs");
    expect(buildScript).not.toContain("db-check.mjs");
  });

  it("serializes concurrent migration runners with a PostgreSQL advisory lock", () => {
    const migrationScript = fs.readFileSync(new URL("../../scripts/db-migrate.mjs", import.meta.url), "utf8");
    expect(migrationScript).toContain("pg_advisory_xact_lock");
    expect(migrationScript).toContain("scenecart:schema-migrations");
  });
});
