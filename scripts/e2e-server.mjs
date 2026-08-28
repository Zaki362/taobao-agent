import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const root = process.cwd();
const nextCli = path.join(root, "node_modules", "next", "dist", "bin", "next");
const nextEnvPath = path.join(root, "next-env.d.ts");
const e2eTsconfigPath = path.join(root, process.env.NEXT_TSCONFIG_PATH || "tsconfig.e2e.json");
const buildTimeoutMs = 90_000;
let stopping = false;

function commandPort(args) {
  const index = args.findIndex((argument) => argument === "--port" || argument === "-p");
  if (index >= 0 && args[index + 1]) return args[index + 1];
  const inline = args.find((argument) => argument.startsWith("--port="));
  return inline?.slice("--port=".length) || "3100";
}

function runCommand(command, args, env, timeoutMs, killProcessGroup = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: "inherit",
      detached: killProcessGroup && process.platform !== "win32"
    });
    let timedOut = false;
    let forceStopTimer = null;
    const stop = (signal) => {
      if (child.killed) return;
      if (killProcessGroup && process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {}
      }
      child.kill(signal);
    };
    const stopWithSigint = () => {
      stopping = true;
      stop("SIGINT");
    };
    const stopWithSigterm = () => {
      stopping = true;
      stop("SIGTERM");
    };
    process.once("SIGINT", stopWithSigint);
    process.once("SIGTERM", stopWithSigterm);
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stop("SIGTERM");
          forceStopTimer = setTimeout(() => stop("SIGKILL"), 5_000);
        }, timeoutMs)
      : null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (forceStopTimer) clearTimeout(forceStopTimer);
      process.removeListener("SIGINT", stopWithSigint);
      process.removeListener("SIGTERM", stopWithSigterm);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (code === 0) resolve();
      else if (timedOut && !stopping) {
        reject(new Error(`command timed out after ${timeoutMs}ms`));
      } else {
        reject(new Error(`${path.basename(command)} exited with ${signal ?? code}`));
      }
    });
  });
}

function runNext(args, env, timeoutMs) {
  return runCommand(process.execPath, [nextCli, ...args], env, timeoutMs, true);
}

function requiredFixtureValue(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`missing isolated E2E fixture setting: ${name}`);
  return value;
}

function tokenDigest(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function seedSingleUserRuntime(env) {
  const runtimeFile = path.resolve(root, requiredFixtureValue(env, "SCENECART_LOCAL_RUNTIME_PATH"));
  const ownerId = requiredFixtureValue(env, "SCENECART_E2E_OWNER_ID");
  const moduleDeviceId = requiredFixtureValue(env, "SCENECART_E2E_MODULE_DEVICE_ID");
  const moduleDeviceToken = requiredFixtureValue(env, "SCENECART_E2E_MODULE_DEVICE_TOKEN");
  const fullDeviceId = requiredFixtureValue(env, "SCENECART_E2E_FULL_DEVICE_ID");
  const fullDeviceToken = requiredFixtureValue(env, "SCENECART_E2E_FULL_DEVICE_TOKEN");
  const now = new Date().toISOString();
  const device = (id, name, token, capabilities) => ({
    id,
    user_id: ownerId,
    name,
    token_hash: tokenDigest(token),
    capabilities,
    status: "offline",
    created_at: now,
    updated_at: now
  });
  const payload = {
    version: 1,
    users: [{
      id: ownerId,
      email: "single-user-e2e@invalid.local",
      password_hash: "interactive-auth-disabled",
      created_at: now,
      updated_at: now
    }],
    auth_sessions: [],
    devices: [
      device(moduleDeviceId, "Playwright 搜索执行器", moduleDeviceToken, ["module_search"]),
      device(fullDeviceId, "Playwright 搜索与加购执行器", fullDeviceToken, ["module_search", "add_to_cart"])
    ],
    jobs: [],
    service_heartbeats: [],
    events: [],
    event_sequence: 0,
    saved_at: now
  };
  const directory = path.dirname(runtimeFile);
  const temporary = `${runtimeFile}.${process.pid}.tmp`;

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.rm(temporary, { force: true });
  try {
    await fs.writeFile(temporary, JSON.stringify(payload), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, runtimeFile);
    await fs.chmod(runtimeFile, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function snapshot(file) {
  return fs.readFile(file, "utf8").catch(() => null);
}

async function restore(file, content) {
  if (content === null) {
    await fs.unlink(file).catch(() => undefined);
    return;
  }
  await fs.writeFile(file, content, "utf8");
}

async function buildWithOneRetry(env, distDir) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await runNext(["build"], env, buildTimeoutMs);
      return;
    } catch (error) {
      if (stopping || attempt === 2) throw error;
      console.warn("[SceneCart E2E] 首次隔离构建未完成，清理测试产物后重试一次");
      await fs.rm(distDir, { recursive: true, force: true });
    }
  }
}

async function prepareStandaloneAssets(distDir) {
  const standaloneDir = path.join(distDir, "standalone");
  const standaloneDistDir = path.join(standaloneDir, path.basename(distDir));
  await fs.cp(path.join(distDir, "static"), path.join(standaloneDistDir, "static"), {
    recursive: true
  });
  await fs.cp(path.join(root, "public"), path.join(standaloneDir, "public"), {
    recursive: true
  });
  return path.join(standaloneDir, "server.js");
}

async function main() {
  const port = commandPort(process.argv.slice(2));
  const env = {
    ...process.env,
    PORT: port,
    HOSTNAME: "127.0.0.1",
    NEXT_DIST_DIR: process.env.NEXT_DIST_DIR || ".next-e2e",
    NEXT_TSCONFIG_PATH: process.env.NEXT_TSCONFIG_PATH || "tsconfig.e2e.json"
  };
  const distDir = path.resolve(root, env.NEXT_DIST_DIR);
  const originalNextEnv = await snapshot(nextEnvPath);
  const originalTsconfig = await snapshot(e2eTsconfigPath);

  await seedSingleUserRuntime(env);

  try {
    await buildWithOneRetry(env, distDir);
  } finally {
    // The immutable server no longer needs TypeScript setup files after build.
    await Promise.all([
      restore(nextEnvPath, originalNextEnv),
      restore(e2eTsconfigPath, originalTsconfig)
    ]);
  }

  const standaloneServer = await prepareStandaloneAssets(distDir);
  await runCommand(process.execPath, [standaloneServer], env);
}

main().catch((error) => {
  console.error(`[SceneCart E2E] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
