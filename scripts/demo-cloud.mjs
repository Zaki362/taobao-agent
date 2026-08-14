import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import nextEnv from "@next/env";
import protocol from "../lib/runtime/executor-protocol.json" with { type: "json" };
import { readCloudRecoverySecret } from "./cloud-demo-config.mjs";
import { resolvePreferredNode22 } from "./dev-auto.mjs";
import { createWorkerSupervisor } from "./dev-auto-supervisor.mjs";
import {
  normalizeCloudDemoUrl,
  parseCloudDemoArgs,
  sanitizeCloudDemoMessage,
  validateCloudRuntime
} from "./demo-cloud-utils.mjs";
import { validateExecutorDeviceToken } from "./executor-config-utils.mjs";

const ROOT = process.cwd();
const NODE_22_REEXEC_FLAG = "SCENECART_DEMO_CLOUD_NODE22_REEXEC";
const LOCK_PATH = path.join(ROOT, ".data", "demo-cloud.lock");
const CHILDREN = {
  executor: path.join(ROOT, "scripts/local-executor.mjs"),
  recovery: path.join(ROOT, "scripts/workflow-recovery-worker.mjs")
};

function help() {
  process.stdout.write(`SceneCart 云端面试演示启动器

用法：
  npm run demo:cloud -- --url https://你的域名
  npm run demo:cloud -- --check --url https://你的域名
  npm run demo:cloud -- --skip-recovery --url https://你的域名

默认会检查云端生产契约、淘宝 MCP、设备令牌与恢复密钥，然后持续运行
本机淘宝 Worker 和恢复 Worker。只有已经配置外部分钟级恢复调度时才使用
--skip-recovery。按 Ctrl+C 统一退出。
`);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    cache: "no-store",
    signal: options.signal ?? AbortSignal.timeout(15_000)
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function checkCloudRuntime(apiBaseUrl) {
  const { response, payload } = await fetchJson(`${apiBaseUrl}/api/runtime/health`);
  if (!response.ok) {
    throw new Error(payload.error || `云端健康检查返回 HTTP ${response.status}`);
  }
  const failures = validateCloudRuntime(payload, protocol.version);
  if (failures.length > 0) {
    throw new Error(`云端运行契约未通过：${failures.join("；")}`);
  }
  process.stdout.write(
    `PASS  cloud_runtime: ${apiBaseUrl} · production · postgres · local_executor · protocol=${protocol.version}\n`
  );
}

async function checkRecoveryAccess(apiBaseUrl, secret) {
  if (secret.length < 32) {
    throw new Error(
      "SCENECART_CRON_SECRET 未配置或不足 32 字符；Hobby 面试演示需要本机维持恢复心跳"
    );
  }
  const { response, payload } = await fetchJson(`${apiBaseUrl}/api/internal/runtime-readiness`, {
    headers: { Authorization: `Bearer ${secret}` }
  });
  if (!response.ok) {
    throw new Error(payload.error || `恢复密钥验证返回 HTTP ${response.status}`);
  }
  process.stdout.write("PASS  recovery_access: 恢复密钥有效；启动后将每 30 秒维持云端恢复心跳\n");
}

function runDoctor(environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "scripts/executor-doctor.mjs")], {
      cwd: ROOT,
      env: environment,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`executor:doctor 未通过（${signal ? `signal ${signal}` : `exit ${code}`}）`));
    });
  });
}

async function relaunchWithNode22IfAvailable() {
  if (process.env[NODE_22_REEXEC_FLAG] === "true") return false;
  const node22 = resolvePreferredNode22();
  if (!node22) {
    if (Number(process.versions.node.split(".")[0]) !== 22) {
      process.stderr.write(
        `[demo:cloud] 当前 Node ${process.versions.node}；未找到 Node 22，将继续运行但建议面试前安装项目要求的 22.x。\n`
      );
    }
    return false;
  }

  const child = spawn(node22, [process.argv[1], ...process.argv.slice(2)], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      [NODE_22_REEXEC_FLAG]: "true",
      PATH: `${path.dirname(node22)}${path.delimiter}${process.env.PATH ?? ""}`
    }
  });
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.exitCode = typeof code === "number" ? code : signal ? 1 : 0;
      resolve();
    });
  });
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  return true;
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === "object" && error.code === "EPERM";
  }
}

function acquireDemoLock() {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(LOCK_PATH, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
      fs.closeSync(descriptor);
      return () => {
        try {
          const owner = Number(fs.readFileSync(LOCK_PATH, "utf8").trim());
          if (owner === process.pid) fs.unlinkSync(LOCK_PATH);
        } catch {
          // A missing lock already represents a complete cleanup.
        }
      };
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
      const owner = Number(fs.readFileSync(LOCK_PATH, "utf8").trim());
      if (Number.isInteger(owner) && owner > 0 && processIsRunning(owner)) {
        throw new Error(`已有 demo:cloud 正在运行（PID ${owner}）；请使用原终端或先按 Ctrl+C 退出`);
      }
      fs.unlinkSync(LOCK_PATH);
    }
  }
  throw new Error("无法取得云端演示进程锁");
}

function createDemoProcessSupervisor({ label, script }) {
  return createWorkerSupervisor({
    async spawnWorker(config) {
      process.stdout.write(`[demo:cloud] 正在启动${label}...\n`);
      return spawn(process.execPath, [script], {
        cwd: ROOT,
        env: config.env,
        stdio: "inherit"
      });
    },
    onRestartScheduled({ attempt, delay }) {
      process.stderr.write(
        `[demo:cloud] ${label}已停止，${Math.ceil(delay / 1000)} 秒后自动重启（第 ${attempt} 次）\n`
      );
    },
    onWorkerExit({ code, signal }) {
      process.stderr.write(
        `[demo:cloud] ${label}退出（${signal ?? `code ${code ?? "unknown"}`}）\n`
      );
    },
    onSpawnError(error) {
      process.stderr.write(
        `[demo:cloud] ${label}启动失败：${sanitizeCloudDemoMessage(error instanceof Error ? error.message : error)}\n`
      );
    }
  });
}

export async function startCloudDemo(args = process.argv.slice(2)) {
  const options = parseCloudDemoArgs(args);
  if (options.help) {
    help();
    return;
  }

  const { combinedEnv } = nextEnv.loadEnvConfig(ROOT);
  const environment = { ...process.env, ...combinedEnv };
  const apiBaseUrl = normalizeCloudDemoUrl(
    options.url ||
    environment.SCENECART_DEMO_CLOUD_URL ||
    environment.SCENECART_RELEASE_VERIFY_URL ||
    environment.SCENECART_API_URL ||
    environment.APP_ORIGIN
  );
  const configuredCloudToken = environment.SCENECART_CLOUD_DEVICE_TOKEN?.trim() ?? "";
  if (!configuredCloudToken) {
    throw new Error(
      "SCENECART_CLOUD_DEVICE_TOKEN 未配置；请先在云端设置页注册设备，再运行 npm run demo:cloud:configure"
    );
  }
  const deviceToken = validateExecutorDeviceToken(configuredCloudToken);
  const recoverySecret = (environment.SCENECART_CRON_SECRET ?? "").trim() ||
    await readCloudRecoverySecret(ROOT);
  const childEnvironment = {
    ...environment,
    TAOBAO_EXECUTION_BACKEND: "local_executor",
    SCENECART_API_URL: apiBaseUrl,
    SCENECART_DEVICE_TOKEN: deviceToken,
    SCENECART_CRON_SECRET: recoverySecret
  };

  process.stdout.write("[demo:cloud] 正在预热云端真实淘宝演示链路...\n");
  await checkCloudRuntime(apiBaseUrl);
  if (options.skipRecovery) {
    process.stdout.write(
      "WARN  recovery_access: 已跳过本机恢复 Worker；仅在外部分钟级调度已经运行时使用此选项\n"
    );
  } else {
    await checkRecoveryAccess(apiBaseUrl, recoverySecret);
  }
  await runDoctor(childEnvironment);

  if (options.checkOnly) {
    process.stdout.write(
      `READY cloud_check: 预检通过；此模式不会保持 Worker 在线。正式演示请运行 npm run demo:cloud -- --url ${apiBaseUrl}\n`
    );
    return;
  }

  const executorSupervisor = createDemoProcessSupervisor({
    label: "真实淘宝 Worker",
    script: CHILDREN.executor
  });
  const recoverySupervisor = options.skipRecovery
    ? null
    : createDemoProcessSupervisor({
      label: "工作流恢复 Worker",
      script: CHILDREN.recovery
    });
  const releaseLock = acquireDemoLock();

  let resolveShutdown;
  const shutdownRequested = new Promise((resolve) => {
    resolveShutdown = resolve;
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    process.stdout.write("\n[demo:cloud] 正在停止本机 Worker；云端网页和已保存 Session 不受影响。\n");
    executorSupervisor.shutdown();
    recoverySupervisor?.shutdown();
    releaseLock();
    resolveShutdown();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  if (recoverySupervisor) {
    recoverySupervisor.reconcile({ token: "workflow-recovery", env: childEnvironment });
  }
  executorSupervisor.reconcile({ token: deviceToken, env: childEnvironment });

  process.stdout.write(`\nREADY cloud_demo: ${apiBaseUrl}\n`);
  process.stdout.write("保持本终端、淘宝桌面版和淘宝登录状态在线；现在可在云端网页逐步演示。\n");
  process.stdout.write("演示结束按 Ctrl+C。此命令适合面试时段，不建议在 Hobby 免费额度下 24 小时常驻。\n\n");
  await shutdownRequested;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  relaunchWithNode22IfAvailable()
    .then((relaunched) => relaunched ? undefined : startCloudDemo())
    .catch((error) => {
      process.stderr.write(
        `[demo:cloud] ${sanitizeCloudDemoMessage(error instanceof Error ? error.message : error)}\n`
      );
      process.exitCode = 1;
    });
}
