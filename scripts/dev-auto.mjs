import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import nextEnv from "@next/env";
import { resolveDevServer } from "./dev-server.mjs";
import { readEnvValue, validateExecutorDeviceToken } from "./executor-config-utils.mjs";
import { createWorkerSupervisor } from "./dev-auto-supervisor.mjs";

export {
  WORKER_RESTART_BASE_MS,
  WORKER_RESTART_MAX_MS,
  WORKER_STABLE_WINDOW_MS,
  workerRestartDelay
} from "./dev-auto-supervisor.mjs";

const TOKEN_DISCOVERY_INTERVAL_MS = 1_500;
const NODE_22_REEXEC_FLAG = "SCENECART_NODE22_REEXEC";
const NODE_22_CANDIDATES = [
  "/opt/homebrew/opt/node@22/bin/node",
  "/usr/local/opt/node@22/bin/node"
];

export function resolvePreferredNode22(options = {}) {
  const nodeMajor = options.nodeMajor ?? Number(process.versions.node.split(".")[0]);
  if (nodeMajor === 22) return "";

  const environment = options.environment ?? process.env;
  const exists = options.exists ?? fs.existsSync;
  const configured = environment.SCENECART_NODE22_PATH?.trim();
  const candidates = configured ? [configured, ...NODE_22_CANDIDATES] : NODE_22_CANDIDATES;
  return candidates.find((candidate) => exists(candidate)) ?? "";
}

async function relaunchWithNode22IfAvailable() {
  if (process.env[NODE_22_REEXEC_FLAG] === "true") return false;
  const node22 = resolvePreferredNode22();
  if (!node22) {
    const currentMajor = Number(process.versions.node.split(".")[0]);
    if (currentMajor !== 22) {
      console.warn(`[dev] 当前 Node ${process.versions.node}，建议安装 Node 22（项目要求 22.x）。`);
    }
    return false;
  }

  const nodeBin = path.dirname(node22);
  const child = spawn(node22, [process.argv[1], ...process.argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      [NODE_22_REEXEC_FLAG]: "true",
      PATH: `${nodeBin}${path.delimiter}${process.env.PATH ?? ""}`
    }
  });
  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  const forwardSigint = () => forwardSignal("SIGINT");
  const forwardSigterm = () => forwardSignal("SIGTERM");
  process.once("SIGINT", forwardSigint);
  process.once("SIGTERM", forwardSigterm);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.exitCode = typeof code === "number" ? code : signal ? 1 : 0;
      resolve();
    });
  });
  process.removeListener("SIGINT", forwardSigint);
  process.removeListener("SIGTERM", forwardSigterm);
  return true;
}

function readLocalEnv(root = process.cwd()) {
  try {
    return fs.readFileSync(path.join(root, ".env.local"), "utf-8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

export function resolveExecutorEnvironment(content, explicitEnvironment, apiBaseUrl) {
  const explicitToken = explicitEnvironment.SCENECART_DEVICE_TOKEN?.trim() ?? "";
  const explicitSourceApp = explicitEnvironment.TAOBAO_SOURCE_APP?.trim() ?? "";
  return {
    TAOBAO_EXECUTION_BACKEND: "local_executor",
    SCENECART_API_URL: apiBaseUrl,
    SCENECART_DEVICE_TOKEN: explicitToken || readEnvValue(content, "SCENECART_DEVICE_TOKEN"),
    TAOBAO_SOURCE_APP: explicitSourceApp || readEnvValue(content, "TAOBAO_SOURCE_APP") || "SceneCartAI"
  };
}

export async function startDevelopmentStack(args = process.argv.slice(2)) {
  const explicitEnvironment = { ...process.env };
  const { combinedEnv } = nextEnv.loadEnvConfig(process.cwd());
  const runtimeEnv = { ...process.env, ...combinedEnv };
  const devServer = await resolveDevServer({ args, env: runtimeEnv });
  const apiBaseUrl = devServer.url;
  runtimeEnv.SCENECART_API_URL = apiBaseUrl;
  runtimeEnv.SCENECART_DEV_PORT = String(devServer.port);

  const processes = new Set();
  let stopping = false;
  let discoveryTimer;
  let lastConfigError = "";

  function spawnCommand(command, commandArgs, name) {
    const child = spawn(command, commandArgs, {
      stdio: "inherit",
      env: runtimeEnv
    });
    processes.add(child);
    child.once("exit", (code) => {
      processes.delete(child);
      if (!stopping && code && code !== 0) {
        console.error(`[${name}] exited with code ${code}`);
      }
    });
    return child;
  }

  function shutdown(exitCode = 0) {
    if (stopping) return;
    stopping = true;
    if (discoveryTimer) clearInterval(discoveryTimer);
    workerSupervisor.shutdown();
    for (const child of processes) {
      if (!child.killed) child.kill("SIGTERM");
    }
    process.exitCode = exitCode;
  }

  process.once("SIGINT", () => shutdown(0));
  process.once("SIGTERM", () => shutdown(0));

  async function waitForApi(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (!stopping && Date.now() < deadline) {
      try {
        const response = await fetch(`${apiBaseUrl}/api/runtime/health`, {
          signal: AbortSignal.timeout(1_500)
        });
        if (response.ok) return true;
      } catch {
        // The development server is still compiling.
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    return false;
  }

  async function discoverAndStartWorker() {
    if (stopping) return;
    const discovered = resolveExecutorEnvironment(
      readLocalEnv(),
      explicitEnvironment,
      apiBaseUrl
    );
    const token = discovered.SCENECART_DEVICE_TOKEN.trim();
    if (!token) return;

    try {
      validateExecutorDeviceToken(token);
      lastConfigError = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : "设备令牌格式无效";
      if (message !== lastConfigError) {
        console.error(`[dev] ${message}`);
        lastConfigError = message;
      }
      return;
    }

    workerSupervisor.reconcile({
      token,
      env: { ...runtimeEnv, ...discovered }
    });
  }

  const workerSupervisor = createWorkerSupervisor({
    async spawnWorker(config) {
      if (!(await waitForApi())) {
        throw new Error(`${apiBaseUrl} 未在限定时间内就绪`);
      }
      console.log("[dev] 已检测到设备令牌，正在启动淘宝桌面版 HTTP MCP 执行器...");
      return spawn("npm", ["run", "worker:local"], {
        stdio: "inherit",
        env: config.env
      });
    },
    onChildSpawn(child) {
      processes.add(child);
    },
    onChildExit(child) {
      processes.delete(child);
    },
    onRestartScheduled({ attempt, delay }) {
      console.error(`[dev] 本地执行器暂未就绪，${Math.ceil(delay / 1000)} 秒后自动重试（第 ${attempt} 次）。`);
    },
    onWorkerExit({ code }) {
      if (code && code !== 0) console.error(`[local-executor] exited with code ${code}`);
    },
    onSpawnError(error) {
      console.error(`[dev] 执行器启动失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  console.log("[dev] 正在启动场景购网页与本地执行器管理器...");
  console.log(`[dev] 页面地址：${apiBaseUrl}`);
  console.log(`[dev] 执行器设置：${apiBaseUrl}/settings/executor`);

  const webProcess = spawnCommand(
    "npm",
    ["run", "dev:web", "--", "--port", String(devServer.port)],
    "next-dev"
  );
  webProcess.once("exit", (code) => {
    if (!stopping) shutdown(typeof code === "number" ? code : 1);
  });

  const initialConfig = resolveExecutorEnvironment(readLocalEnv(), explicitEnvironment, apiBaseUrl);
  if (!initialConfig.SCENECART_DEVICE_TOKEN.trim()) {
    console.log("[dev] 尚未配置设备令牌；网页将先启动。完成设备注册和 executor:configure 后，本进程会自动接入 Worker。");
  }
  await discoverAndStartWorker();
  discoveryTimer = setInterval(() => {
    discoverAndStartWorker().catch((error) => {
      console.error(`[dev] 执行器配置检测失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }, TOKEN_DISCOVERY_INTERVAL_MS);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  relaunchWithNode22IfAvailable()
    .then((relaunched) => relaunched ? undefined : startDevelopmentStack())
    .catch((error) => {
      console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
