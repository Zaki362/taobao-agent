import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import nextEnv from "@next/env";
import { resolveDevServer } from "./dev-server.mjs";
import { readEnvValue, validateExecutorDeviceToken } from "./executor-config-utils.mjs";

const TOKEN_DISCOVERY_INTERVAL_MS = 1_500;

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
  let workerProcess = null;
  let workerStarting = false;
  let lastAttemptedToken = "";
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
    if (stopping || workerStarting || workerProcess) return;
    const discovered = resolveExecutorEnvironment(
      readLocalEnv(),
      explicitEnvironment,
      apiBaseUrl
    );
    const token = discovered.SCENECART_DEVICE_TOKEN.trim();
    if (!token || token === lastAttemptedToken) return;

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

    workerStarting = true;
    lastAttemptedToken = token;
    Object.assign(runtimeEnv, discovered);
    try {
      if (!(await waitForApi())) {
        console.error(`[dev] ${apiBaseUrl} 未在限定时间内就绪，本地执行器未启动。`);
        return;
      }
      console.log("[dev] 已检测到设备令牌，正在启动淘宝桌面版 HTTP MCP 执行器...");
      workerProcess = spawnCommand("npm", ["run", "worker:local"], "local-executor");
      workerProcess.once("exit", (code) => {
        workerProcess = null;
        if (!stopping && code && code !== 0) {
          console.error("[dev] 本地执行器启动失败。请运行 npm run executor:doctor；修复后可单独运行 npm run worker:local，或重新注册设备令牌。");
        }
      });
    } finally {
      workerStarting = false;
    }
  }

  console.log("[dev] 正在启动 SceneCart AI 网页与本地执行器管理器...");
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
  startDevelopmentStack().catch((error) => {
    console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
