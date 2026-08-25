import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withRestoredNextBuildConfiguration } from "../../scripts/build.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fsp.rm(directory, { recursive: true, force: true })
  ));
});

async function createBuildFixture(tsconfigName = "tsconfig.json") {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "scenecart-build-script-"));
  temporaryDirectories.push(root);
  const nextEnvPath = path.join(root, "next-env.d.ts");
  const tsconfigPath = path.join(root, tsconfigName);
  await Promise.all([
    fsp.writeFile(nextEnvPath, "original next env\n", "utf8"),
    fsp.writeFile(tsconfigPath, "original tsconfig\n", "utf8")
  ]);
  return { root, nextEnvPath, tsconfigPath };
}

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

  it("restores Next.js generated files after a successful isolated build", async () => {
    const fixture = await createBuildFixture("tsconfig.build.json");
    const result = await withRestoredNextBuildConfiguration(async () => {
      await Promise.all([
        fsp.writeFile(fixture.nextEnvPath, "generated next env\n", "utf8"),
        fsp.writeFile(fixture.tsconfigPath, "generated tsconfig\n", "utf8")
      ]);
      return 0;
    }, {
      root: fixture.root,
      environment: { NEXT_TSCONFIG_PATH: "tsconfig.build.json" }
    });

    expect(result).toBe(0);
    await expect(fsp.readFile(fixture.nextEnvPath, "utf8")).resolves.toBe("original next env\n");
    await expect(fsp.readFile(fixture.tsconfigPath, "utf8")).resolves.toBe("original tsconfig\n");
  });

  it("restores the default tsconfig after a failed Next.js build", async () => {
    const fixture = await createBuildFixture();
    const result = await withRestoredNextBuildConfiguration(async () => {
      await Promise.all([
        fsp.writeFile(fixture.nextEnvPath, "failed build next env\n", "utf8"),
        fsp.writeFile(fixture.tsconfigPath, "failed build tsconfig\n", "utf8")
      ]);
      return 1;
    }, { root: fixture.root, environment: {} });

    expect(result).toBe(1);
    await expect(fsp.readFile(fixture.nextEnvPath, "utf8")).resolves.toBe("original next env\n");
    await expect(fsp.readFile(fixture.tsconfigPath, "utf8")).resolves.toBe("original tsconfig\n");
  });
});
