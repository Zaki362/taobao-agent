import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import nextEnv from "@next/env";
import pg from "pg";
import { databaseSslConfig } from "./database-ssl.mjs";
import { safeMachineErrorMessage } from "./vercel-protection-bypass.mjs";

const { Pool } = pg;
const ALLOWED_CAPABILITIES = new Set(["module_search", "add_to_cart"]);
const DEFAULT_CAPABILITIES = ["module_search"];
const DEFAULT_DEVICE_NAME = "SceneCart 单用户执行器";
const DEFAULT_ENV_KEY = "SCENECART_DEVICE_TOKEN";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encodeEnvValue(value) {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : JSON.stringify(value);
}

export function updateProvisionedToken(content, token, key = DEFAULT_ENV_KEY) {
  const source = String(content ?? "").split(/\r?\n/);
  let replaced = false;
  const lines = source
    .filter((line, index) => !(index === source.length - 1 && line === ""))
    .map((line) => {
      if (!new RegExp(`^\\s*${key}\\s*=`).test(line)) return line;
      if (replaced) return null;
      replaced = true;
      return `${key}=${encodeEnvValue(token)}`;
    })
    .filter((line) => line !== null);
  if (!replaced) {
    if (lines.length > 0 && lines.at(-1)?.trim()) lines.push("");
    lines.push("# SceneCart operator-provisioned single-user device", `${key}=${encodeEnvValue(token)}`);
  }
  return `${lines.join("\n")}\n`;
}

function parseCapabilities(value) {
  const capabilities = [...new Set(String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
  if (capabilities.length === 0 || capabilities.some((item) => !ALLOWED_CAPABILITIES.has(item))) {
    throw new Error("--capabilities 只支持 module_search 或 module_search,add_to_cart");
  }
  if (!capabilities.includes("module_search")) {
    throw new Error("设备必须显式包含 module_search 能力");
  }
  return capabilities;
}

export function parseProvisionArgs(argv) {
  const result = {
    capabilities: [...DEFAULT_CAPABILITIES],
    capabilitiesProvided: false,
    deviceName: DEFAULT_DEVICE_NAME,
    deviceNameProvided: false,
    rotateDeviceId: ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { ...result, help: true };
    if (!["--name", "--capabilities", "--rotate"].includes(argument)) {
      throw new Error(`不支持的参数：${argument}`);
    }
    const value = argv[index + 1]?.trim();
    if (!value || value.startsWith("--")) throw new Error(`${argument} 缺少值`);
    index += 1;
    if (argument === "--name") {
      result.deviceName = value.slice(0, 80);
      result.deviceNameProvided = true;
    } else if (argument === "--capabilities") {
      result.capabilities = parseCapabilities(value);
      result.capabilitiesProvided = true;
    } else {
      if (!UUID_PATTERN.test(value)) throw new Error("--rotate 必须是有效设备 UUID");
      result.rotateDeviceId = value;
    }
  }
  return result;
}

export function validateProvisionEnvironment(environment) {
  if (environment.SCENECART_PRODUCT_MODE !== "production") {
    throw new Error("拒绝签发：SCENECART_PRODUCT_MODE 必须为 production");
  }
  if (environment.SCENECART_ACCESS_MODE !== "single_user") {
    throw new Error("拒绝签发：SCENECART_ACCESS_MODE 必须为 single_user");
  }
  if (environment.RUNTIME_STORE !== "postgres") {
    throw new Error("拒绝签发：RUNTIME_STORE 必须为 postgres");
  }
  const ownerId = environment.SCENECART_SINGLE_USER_ID?.trim() ?? "";
  if (!UUID_PATTERN.test(ownerId)) {
    throw new Error("拒绝签发：SCENECART_SINGLE_USER_ID 缺失或格式无效");
  }
  const databaseUrl = environment.DATABASE_URL?.trim() ?? "";
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("拒绝签发：DATABASE_URL 缺失或无效");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new Error("拒绝签发：DATABASE_URL 必须是 PostgreSQL 连接地址");
  }
  databaseSslConfig(environment);
  return { databaseUrl, ownerId };
}

async function readTokenFile(target, fsImpl) {
  try {
    const stat = await fsImpl.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("令牌目标必须是普通文件，拒绝写入符号链接或目录");
    }
    return { content: await fsImpl.readFile(target, "utf8"), existed: true };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { content: "", existed: false };
    }
    throw error;
  }
}

async function writeTokenFile(target, content, fsImpl) {
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await fsImpl.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fsImpl.rename(temporary, target);
    await fsImpl.chmod(target, 0o600);
  } catch (error) {
    await fsImpl.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function restoreTokenFile(target, previous, fsImpl) {
  if (!previous.existed) {
    await fsImpl.unlink(target).catch(() => undefined);
    return;
  }
  await writeTokenFile(target, previous.content, fsImpl);
}

export function sanitizeProvisionError(error, environment = process.env) {
  let message = safeMachineErrorMessage(error, environment);
  const ownerId = environment.SCENECART_SINGLE_USER_ID?.trim();
  if (ownerId) message = message.replaceAll(ownerId, "[redacted-owner]");
  return message;
}

export async function provisionSingleUserDevice({
  argv = [],
  cwd = process.cwd(),
  environment = process.env,
  fsImpl = fs,
  poolFactory = (config) => new Pool(config),
  randomBytesImpl = randomBytes,
  randomUUIDImpl = randomUUID,
  output = process.stdout
} = {}) {
  const options = parseProvisionArgs(argv);
  if (options.help) {
    output.write(
      "用法：npm run executor:provision -- [--name 本地执行器] [--capabilities module_search,add_to_cart] [--rotate 设备UUID]\n" +
      "仅限受控运维终端；固定 owner、数据库凭据和设备令牌只从服务端/本机环境读取，不接受命令行传入。\n"
    );
    return { help: true };
  }

  const { databaseUrl, ownerId } = validateProvisionEnvironment(environment);
  const target = path.join(cwd, ".env.local");
  const previous = await readTokenFile(target, fsImpl);
  const rawToken = `scdev_${randomBytesImpl(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const deviceId = options.rotateDeviceId || randomUUIDImpl();
  const pool = poolFactory({
    connectionString: databaseUrl,
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
    ssl: databaseSslConfig(environment)
  });
  let client;
  let tokenFileWritten = false;
  let preserveNewTokenOnFailure = false;
  let effectiveCapabilities = options.capabilities;
  let effectiveDeviceName = options.deviceName;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const owner = await client.query(
      "SELECT id FROM app_users WHERE id = $1 FOR SHARE",
      [ownerId]
    );
    if (owner.rowCount !== 1) {
      throw new Error("固定 owner 不存在，设备未签发");
    }

    if (options.rotateDeviceId) {
      const existing = await client.query(
        "SELECT id, name, capabilities, status FROM executor_devices WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [deviceId, ownerId]
      );
      if (existing.rowCount !== 1) {
        throw new Error("待轮换设备不存在或不属于固定 owner，设备未变更");
      }
      const currentDevice = existing.rows[0];
      if (currentDevice.status === "revoked") {
        throw new Error("待轮换设备已撤销，拒绝重新激活；请显式签发新设备");
      }
      effectiveDeviceName = options.deviceNameProvided
        ? options.deviceName
        : String(currentDevice.name ?? "").trim().slice(0, 80);
      if (!effectiveDeviceName) {
        throw new Error("待轮换设备名称无效，设备未变更");
      }
      effectiveCapabilities = options.capabilitiesProvided
        ? options.capabilities
        : parseCapabilities(
            Array.isArray(currentDevice.capabilities)
              ? currentDevice.capabilities.join(",")
              : ""
          );
      await client.query(
        `UPDATE executor_devices
         SET name = $3, token_hash = $4, capabilities = $5::jsonb,
             status = 'offline', last_heartbeat_at = NULL, updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [deviceId, ownerId, effectiveDeviceName, tokenHash, JSON.stringify(effectiveCapabilities)]
      );
    } else {
      await client.query(
        `INSERT INTO executor_devices
           (id, user_id, name, token_hash, capabilities, status, last_heartbeat_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'offline', NULL, NOW(), NOW())`,
        [deviceId, ownerId, options.deviceName, tokenHash, JSON.stringify(options.capabilities)]
      );
    }
    await client.query(
      `INSERT INTO execution_events (user_id, session_id, event_type, payload)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        ownerId,
        `executor-device:${deviceId}`,
        options.rotateDeviceId ? "executor.device_token_rotated" : "executor.device_registered",
        JSON.stringify({
          device_id: deviceId,
          device_name: effectiveDeviceName,
          capabilities: effectiveCapabilities,
          provisioned_by: "operator_cli"
        })
      ]
    );

    await writeTokenFile(target, updateProvisionedToken(previous.content, rawToken), fsImpl);
    tokenFileWritten = true;
    try {
      await client.query("COMMIT");
    } catch (commitError) {
      client.release(true);
      client = undefined;
      let verificationClient;
      let committedDevice;
      try {
        verificationClient = await pool.connect();
        const verification = await verificationClient.query(
          "SELECT token_hash, status FROM executor_devices WHERE id = $1 AND user_id = $2",
          [deviceId, ownerId]
        );
        committedDevice = verification.rowCount === 1 ? verification.rows[0] : null;
      } catch {
        preserveNewTokenOnFailure = true;
        throw new Error(
          `数据库提交结果无法核验；已保留新 Token 但 Worker 不得启动。恢复数据库连接后检查 device_id=${deviceId}：设备存在则执行 npm run executor:provision -- --rotate ${deviceId}，不存在则重新签发`
        );
      } finally {
        verificationClient?.release();
      }
      if (committedDevice?.token_hash !== tokenHash || committedDevice.status === "revoked") {
        throw commitError;
      }
    }
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    if (tokenFileWritten && !preserveNewTokenOnFailure) {
      await restoreTokenFile(target, previous, fsImpl).catch(() => undefined);
    }
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }

  output.write(`${options.rotateDeviceId ? "设备令牌已轮换" : "设备已签发"}；device_id=${deviceId}\n`);
  output.write("明文令牌已安全保存到本机 .env.local（权限 0600），终端不显示令牌或 owner。\n");
  output.write(`授权能力：${effectiveCapabilities.join(",")}\n`);
  return { capabilities: effectiveCapabilities, deviceId, target };
}

export async function main() {
  nextEnv.loadEnvConfig(process.cwd());
  await provisionSingleUserDevice({ argv: process.argv.slice(2) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[executor:provision] ${sanitizeProvisionError(error)}\n`);
    process.exitCode = 1;
  });
}
