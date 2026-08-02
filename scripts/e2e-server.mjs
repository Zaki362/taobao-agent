import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

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
