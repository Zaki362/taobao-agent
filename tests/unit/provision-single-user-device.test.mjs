import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseProvisionArgs,
  provisionSingleUserDevice,
  sanitizeProvisionError,
  updateProvisionedToken,
  validateProvisionEnvironment
} from "../../scripts/provision-single-user-device.mjs";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const DATABASE_URL = "postgresql://operator:top-secret@db.example.test/scenecart";
const ENVIRONMENT = {
  DATABASE_URL,
  DATABASE_SSL: "true",
  DATABASE_SSL_REJECT_UNAUTHORIZED: "true",
  RUNTIME_STORE: "postgres",
  SCENECART_ACCESS_MODE: "single_user",
  SCENECART_PRODUCT_MODE: "production",
  SCENECART_SINGLE_USER_ID: OWNER_ID
};
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

async function temporaryRoot() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scenecart-provision-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeDatabase({
  ownerExists = true,
  deviceExists = true,
  deviceStatus = "offline",
  commitApplied = false,
  commitError,
  verificationError
} = {}) {
  const calls = [];
  const releases = [];
  const client = {
    async query(text, values = []) {
      calls.push({ text: String(text), values });
      if (String(text) === "COMMIT" && commitError) throw commitError;
      if (/SELECT token_hash, status FROM executor_devices/.test(String(text))) {
        if (verificationError) throw verificationError;
        const write = [...calls].reverse().find((call) =>
          /INSERT INTO executor_devices|UPDATE executor_devices/.test(call.text)
        );
        return commitApplied
          ? { rowCount: 1, rows: [{ token_hash: write?.values[3], status: "offline" }] }
          : { rowCount: 0, rows: [] };
      }
      if (/SELECT id FROM app_users/.test(String(text))) {
        return { rowCount: ownerExists ? 1 : 0, rows: ownerExists ? [{ id: OWNER_ID }] : [] };
      }
      if (/FROM executor_devices/.test(String(text))) {
        return {
          rowCount: deviceExists ? 1 : 0,
          rows: deviceExists ? [{
            id: DEVICE_ID,
            name: "Existing Worker",
            capabilities: ["module_search", "add_to_cart"],
            status: deviceStatus
          }] : []
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release(destroy) { releases.push(destroy); }
  };
  const pool = {
    async connect() { return client; },
    async end() {}
  };
  return { calls, poolFactory: () => pool, releases };
}

describe("single-user executor device provisioning", () => {
  it("requires the fixed-owner PostgreSQL contract and rejects other database schemes", () => {
    expect(validateProvisionEnvironment(ENVIRONMENT)).toEqual({
      databaseUrl: DATABASE_URL,
      ownerId: OWNER_ID
    });
    expect(() => validateProvisionEnvironment({ ...ENVIRONMENT, SCENECART_ACCESS_MODE: "account" }))
      .toThrow(/single_user/);
    expect(() => validateProvisionEnvironment({ ...ENVIRONMENT, SCENECART_PRODUCT_MODE: "development" }))
      .toThrow(/production/);
    expect(() => validateProvisionEnvironment({ ...ENVIRONMENT, RUNTIME_STORE: "local" }))
      .toThrow(/postgres/);
    expect(() => validateProvisionEnvironment({ ...ENVIRONMENT, SCENECART_SINGLE_USER_ID: "anonymous" }))
      .toThrow(/SINGLE_USER_ID/);
    expect(() => validateProvisionEnvironment({ ...ENVIRONMENT, DATABASE_URL: "https://db.example.test" }))
      .toThrow(/PostgreSQL/);
    expect(() => validateProvisionEnvironment({ ...ENVIRONMENT, DATABASE_SSL: "false" }))
      .toThrow(/DATABASE_SSL=true/);
    expect(() => validateProvisionEnvironment({
      ...ENVIRONMENT,
      DATABASE_SSL_REJECT_UNAUTHORIZED: "false"
    })).toThrow(/禁止关闭 PostgreSQL 证书校验/);
  });

  it("accepts only explicit search/cart capabilities and a UUID rotation target", () => {
    expect(parseProvisionArgs([
      "--name", "Mac Worker",
      "--capabilities", "module_search,add_to_cart",
      "--rotate", DEVICE_ID
    ])).toEqual({
      capabilities: ["module_search", "add_to_cart"],
      capabilitiesProvided: true,
      deviceName: "Mac Worker",
      deviceNameProvided: true,
      rotateDeviceId: DEVICE_ID
    });
    expect(() => parseProvisionArgs(["--capabilities", "add_to_cart"]))
      .toThrow(/module_search/);
    expect(() => parseProvisionArgs(["--capabilities", "module_search,pay_order"]))
      .toThrow(/只支持/);
    expect(() => parseProvisionArgs(["--rotate", "not-a-device-id"]))
      .toThrow(/UUID/);
  });

  it("preserves unrelated local settings and keeps a single token entry", () => {
    const configured = updateProvisionedToken(
      "SCENECART_API_URL=https://example.test\nSCENECART_DEVICE_TOKEN=old\nSCENECART_DEVICE_TOKEN=duplicate\n",
      "new-token"
    );
    expect(configured).toContain("SCENECART_API_URL=https://example.test");
    expect(configured).toContain("SCENECART_DEVICE_TOKEN=new-token");
    expect(configured.match(/SCENECART_DEVICE_TOKEN=/g)).toHaveLength(1);
    expect(configured).not.toContain("old");
    expect(configured).not.toContain("duplicate");
  });

  it("creates an owner-bound device, stores only a SHA-256 digest, and writes the raw token with mode 0600", async () => {
    const cwd = await temporaryRoot();
    await fs.writeFile(path.join(cwd, ".env.local"), "KEEP_ME=yes\n", { mode: 0o644 });
    const database = fakeDatabase();
    let output = "";
    await provisionSingleUserDevice({
      argv: ["--capabilities", "module_search,add_to_cart"],
      cwd,
      environment: ENVIRONMENT,
      poolFactory: database.poolFactory,
      randomBytesImpl: () => Buffer.alloc(32, 7),
      randomUUIDImpl: () => DEVICE_ID,
      output: { write: (value) => { output += value; } }
    });

    const localEnv = await fs.readFile(path.join(cwd, ".env.local"), "utf8");
    const rawToken = localEnv.match(/^SCENECART_DEVICE_TOKEN=(.+)$/m)?.[1];
    expect(rawToken).toMatch(/^scdev_[A-Za-z0-9_-]+$/);
    expect(localEnv).toContain("KEEP_ME=yes");
    expect((await fs.stat(path.join(cwd, ".env.local"))).mode & 0o777).toBe(0o600);

    const insert = database.calls.find((call) => /INSERT INTO executor_devices/.test(call.text));
    expect(insert.values[0]).toBe(DEVICE_ID);
    expect(insert.values[1]).toBe(OWNER_ID);
    expect(insert.values[3]).toMatch(/^[0-9a-f]{64}$/);
    expect(insert.values[3]).not.toBe(rawToken);
    expect(insert.values[3]).toBe(createHash("sha256").update(rawToken).digest("hex"));
    expect(insert.values[4]).toBe('["module_search","add_to_cart"]');
    expect(database.calls.map((call) => JSON.stringify(call.values)).join("\n")).not.toContain(rawToken);
    expect(output).toContain(`device_id=${DEVICE_ID}`);
    expect(output).not.toContain(rawToken);
    expect(output).not.toContain(OWNER_ID);
    expect(output).not.toContain("top-secret");
  });

  it("rotates only a device belonging to the fixed owner, preserves metadata, and invalidates the old token", async () => {
    const cwd = await temporaryRoot();
    await fs.writeFile(path.join(cwd, ".env.local"), "SCENECART_DEVICE_TOKEN=old-token\n", { mode: 0o600 });
    const database = fakeDatabase();
    await provisionSingleUserDevice({
      argv: ["--rotate", DEVICE_ID],
      cwd,
      environment: ENVIRONMENT,
      poolFactory: database.poolFactory,
      randomBytesImpl: () => Buffer.alloc(32, 9),
      output: { write() {} }
    });

    expect(database.calls.some((call) => /INSERT INTO executor_devices/.test(call.text))).toBe(false);
    const update = database.calls.find((call) => /UPDATE executor_devices/.test(call.text));
    expect(update.values.slice(0, 2)).toEqual([DEVICE_ID, OWNER_ID]);
    expect(update.values[2]).toBe("Existing Worker");
    expect(update.values[3]).toMatch(/^[0-9a-f]{64}$/);
    expect(update.values[4]).toBe('["module_search","add_to_cart"]');
    expect(await fs.readFile(path.join(cwd, ".env.local"), "utf8")).not.toContain("old-token");
  });

  it("never revives a revoked device during token rotation", async () => {
    const cwd = await temporaryRoot();
    const database = fakeDatabase({ deviceStatus: "revoked" });
    await expect(provisionSingleUserDevice({
      argv: ["--rotate", DEVICE_ID],
      cwd,
      environment: ENVIRONMENT,
      poolFactory: database.poolFactory,
      output: { write() {} }
    })).rejects.toThrow(/已撤销/);
    expect(database.calls.some((call) => /UPDATE executor_devices/.test(call.text))).toBe(false);
    await expect(fs.stat(path.join(cwd, ".env.local"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back without writing a token when the owner or rotation target is invalid", async () => {
    const cwd = await temporaryRoot();
    const missingOwner = fakeDatabase({ ownerExists: false });
    await expect(provisionSingleUserDevice({
      cwd,
      environment: ENVIRONMENT,
      poolFactory: missingOwner.poolFactory,
      output: { write() {} }
    })).rejects.toThrow(/owner 不存在/);
    await expect(fs.stat(path.join(cwd, ".env.local"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(missingOwner.calls.some((call) => call.text === "ROLLBACK")).toBe(true);

    const missingDevice = fakeDatabase({ deviceExists: false });
    await expect(provisionSingleUserDevice({
      argv: ["--rotate", DEVICE_ID],
      cwd,
      environment: ENVIRONMENT,
      poolFactory: missingDevice.poolFactory,
      output: { write() {} }
    })).rejects.toThrow(/不属于固定 owner/);
    await expect(fs.stat(path.join(cwd, ".env.local"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the previous local token if the database commit fails", async () => {
    const cwd = await temporaryRoot();
    const target = path.join(cwd, ".env.local");
    await fs.writeFile(target, "SCENECART_DEVICE_TOKEN=previous-token\n", { mode: 0o600 });
    const database = fakeDatabase({ commitError: new Error(`commit failed for ${DATABASE_URL}`) });
    await expect(provisionSingleUserDevice({
      cwd,
      environment: ENVIRONMENT,
      poolFactory: database.poolFactory,
      randomUUIDImpl: () => DEVICE_ID,
      output: { write() {} }
    })).rejects.toThrow(/commit failed/);
    expect(await fs.readFile(target, "utf8")).toBe("SCENECART_DEVICE_TOKEN=previous-token\n");
  });

  it("keeps the new token when an ambiguous commit is verified as applied", async () => {
    const cwd = await temporaryRoot();
    const target = path.join(cwd, ".env.local");
    await fs.writeFile(target, "SCENECART_DEVICE_TOKEN=previous-token\n", { mode: 0o600 });
    const database = fakeDatabase({
      commitApplied: true,
      commitError: new Error("connection closed after commit")
    });
    await provisionSingleUserDevice({
      cwd,
      environment: ENVIRONMENT,
      poolFactory: database.poolFactory,
      randomBytesImpl: () => Buffer.alloc(32, 11),
      randomUUIDImpl: () => DEVICE_ID,
      output: { write() {} }
    });
    expect(await fs.readFile(target, "utf8")).not.toContain("previous-token");
    expect(database.releases).toContain(true);
  });

  it("fails closed without reverting the new token when commit state cannot be verified", async () => {
    const cwd = await temporaryRoot();
    const target = path.join(cwd, ".env.local");
    await fs.writeFile(target, "SCENECART_DEVICE_TOKEN=previous-token\n", { mode: 0o600 });
    const database = fakeDatabase({
      commitError: new Error("connection closed during commit"),
      verificationError: new Error("database unavailable")
    });
    await expect(provisionSingleUserDevice({
      cwd,
      environment: ENVIRONMENT,
      poolFactory: database.poolFactory,
      randomBytesImpl: () => Buffer.alloc(32, 12),
      randomUUIDImpl: () => DEVICE_ID,
      output: { write() {} }
    })).rejects.toThrow(/提交结果无法核验/);
    const localEnv = await fs.readFile(target, "utf8");
    expect(localEnv).not.toContain("previous-token");
    expect(database.releases).toContain(true);
    await expect(provisionSingleUserDevice({
      argv: ["--rotate", DEVICE_ID],
      cwd,
      environment: ENVIRONMENT,
      poolFactory: fakeDatabase().poolFactory,
      output: { write() {} }
    })).resolves.toMatchObject({ deviceId: DEVICE_ID });
  });

  it("redacts database credentials and the fixed owner from operator-facing errors", () => {
    const message = sanitizeProvisionError(
      new Error(`owner ${OWNER_ID} failed at ${DATABASE_URL}`),
      ENVIRONMENT
    );
    expect(message).toContain("[redacted-owner]");
    expect(message).toContain("[redacted-database-url]");
    expect(message).not.toContain(OWNER_ID);
    expect(message).not.toContain("top-secret");
  });
});
