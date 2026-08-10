import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import nextEnv from "@next/env";
import protocol from "../lib/runtime/executor-protocol.json" with { type: "json" };
import { ExecutorLeaseGuard } from "./executor-lease-guard.mjs";
import { TaobaoMcpClient } from "./taobao-mcp-client.mjs";
import {
  isTaobaoLoginError,
  normalizeTaobaoCartResult,
  normalizeTaobaoSearchEvidence
} from "./local-executor-utils.mjs";

nextEnv.loadEnvConfig(process.cwd());

const apiBaseUrl = (process.env.SCENECART_API_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const deviceToken = process.env.SCENECART_DEVICE_TOKEN;
const taobaoMcpUrl = process.env.TAOBAO_NATIVE_MCP_URL || "http://127.0.0.1:3654/mcp";
const pollMs = Math.max(Number(process.env.EXECUTOR_POLL_MS || 2500), 500);
const taobaoSearchTimeoutMs = Math.max(Number(process.env.EXECUTOR_TAOBAO_SEARCH_TIMEOUT_MS || 60000), 15000);
const taobaoCartTimeoutMs = Math.max(Number(process.env.EXECUTOR_TAOBAO_CART_TIMEOUT_MS || 60000), 15000);
const taobaoSearchCooldownMs = Math.max(Number(process.env.EXECUTOR_TAOBAO_SEARCH_COOLDOWN_MS || 30000), 0);
const taobaoSourceApp = process.env.TAOBAO_SOURCE_APP || "SceneCartAI";
const apiTimeoutMs = Math.max(Number(process.env.EXECUTOR_API_TIMEOUT_MS || 20000), 5000);
const resolveTimeoutMs = Math.max(Number(process.env.EXECUTOR_RESOLVE_TIMEOUT_MS || 60000), apiTimeoutMs);
const leaseFailureLimit = Math.max(Number(process.env.EXECUTOR_LEASE_FAILURE_LIMIT || 3), 1);
const resultDir = path.join(process.cwd(), ".data", "local-executor", "results");
const executorProtocolVersion = protocol.version;
if (!deviceToken) {
  throw new Error("SCENECART_DEVICE_TOKEN is required. Register a device at /settings/executor first.");
}

let heartbeatInFlight = false;
let stopped = false;
let authenticationPaused = false;
let lastTaobaoSearchFinishedAt = 0;
const leaseGuard = new ExecutorLeaseGuard({
  failureLimit: leaseFailureLimit,
  onLeaseLost: ({ jobId, reason }) => {
    process.stderr.write(`[local-executor] lease lost for ${jobId}: ${reason}; stopping local execution\n`);
  }
});

class ExecutorJobError extends Error {
  constructor(message, retryable = true, code = "operation_failed") {
    super(message);
    this.name = "ExecutorJobError";
    this.retryable = retryable;
    this.code = code;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(apiTimeoutMs),
    headers: {
      Authorization: `Bearer ${deviceToken}`,
      "Content-Type": "application/json",
      "X-SceneCart-Executor-Protocol": executorProtocolVersion,
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${path} failed with ${response.status}`);
  return payload;
}

async function verifyStartup() {
  const tools = await taobaoClient.listTools();
  const toolNames = new Set(tools.map((tool) => tool?.name));
  if (!toolNames.has("search_products")) {
    throw new Error("淘宝桌面版 MCP 未暴露 search_products 工具");
  }
  const response = await fetch(`${apiBaseUrl}/api/runtime/health`, {
    signal: AbortSignal.timeout(apiTimeoutMs)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status !== "healthy") {
    throw new Error(payload.error || `SceneCart API health check failed with ${response.status}`);
  }
  if (payload.executor_protocol_version !== executorProtocolVersion) {
    throw new Error(
      `执行器协议不兼容：本地=${executorProtocolVersion}，服务端=${payload.executor_protocol_version ?? "未知"}。请更新项目代码后重启。`
    );
  }
  const heartbeatPayload = await api("/api/executor/heartbeat", {
    method: "POST",
    body: "{}"
  });
  const capabilities = Array.isArray(heartbeatPayload.device?.capabilities)
    ? heartbeatPayload.device.capabilities
    : [];
  if (!capabilities.includes("module_search")) {
    throw new Error("设备令牌没有 module_search 能力，请在执行器设置页重新注册搜索设备。");
  }
  if (capabilities.includes("add_to_cart") && !toolNames.has("add_to_cart")) {
    throw new Error("设备声明了 add_to_cart 能力，但淘宝桌面版 MCP 未暴露加购工具。");
  }
  if (heartbeatPayload.protocol_version !== executorProtocolVersion) {
    throw new Error("服务端未确认当前执行器协议，请更新项目代码后重启。");
  }
  process.stdout.write(
    `[local-executor] startup checks passed; driver=taobao-mcp-http; runtime=${payload.runtime_store}; backend=${payload.effective_executor_backend}; capabilities=${capabilities.join(",")}\n`
  );
}

function errorOutput(error) {
  const candidate = error && typeof error === "object" ? error : {};
  return [candidate.stdout, candidate.stderr, candidate.message, String(error ?? "")]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n")
    .trim();
}

function operationSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function createTaobaoMcpClient(timeoutMs) {
  return new TaobaoMcpClient({
    endpoint: taobaoMcpUrl,
    sourceApp: taobaoSourceApp,
    timeoutMs
  });
}

// Streamable HTTP sessions are stateful. Reuse one transport for the complete
// worker lifetime so Taobao Desktop keeps one consistent WebView/MCP context.
const taobaoClient = createTaobaoMcpClient(Math.max(taobaoSearchTimeoutMs, taobaoCartTimeoutMs));

async function readCachedResult(job) {
  try {
    const result = JSON.parse(await fs.readFile(path.join(resultDir, `${job.id}.json`), "utf-8"));
    if (
      job.job_type === "module_search" &&
      !["taobao-mcp", "taobao-native"].includes(result?.evidence?.source)
    ) {
      process.stderr.write(
        `[local-executor] ignored unverified legacy search cache for ${job.id}\n`
      );
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

async function cacheResult(jobId, result) {
  await fs.mkdir(resultDir, { recursive: true });
  const target = path.join(resultDir, `${jobId}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(result), "utf-8");
  await fs.rename(temporary, target);
}

async function reportResult(jobId, payload) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await api(`/api/executor/jobs/${jobId}/resolve`, {
        method: "POST",
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(resolveTimeoutMs)
      });
    } catch (error) {
      lastError = error;
      await sleep(attempt * 750);
    }
  }
  throw lastError;
}

function taobaoJobError(error, operation = "操作") {
  const output = errorOutput(error);
  if (isTaobaoLoginError(output)) {
    return new ExecutorJobError(
      "淘宝桌面版当前未登录。请完成登录并保持主界面打开后重试。",
      false,
      "auth_required"
    );
  }
  if (/Tool 执行层未就绪|应用已加载完成|连接失败|cli-rpc\.sock|ECONNREFUSED/i.test(output)) {
    return new ExecutorJobError(
      "淘宝桌面版工具执行层暂未就绪，请保持客户端主界面打开后重试。",
      true
    );
  }
  if (/timed out|timeout|SIGTERM|SIGKILL/i.test(output)) {
    return new ExecutorJobError(`淘宝${operation}在限定时间内未完成。`, true);
  }
  if (/fetch failed|ECONNREFUSED|MCP.*请求失败|会话 ID/i.test(output)) {
    return new ExecutorJobError("淘宝桌面版 MCP 暂不可达，请保持客户端运行后重试。", true);
  }
  return new ExecutorJobError(output ? output.slice(0, 1000) : `淘宝 MCP 未返回${operation}结果。`, true);
}

async function executeJob(job, signal) {
  const payload = job.payload || {};
  if (job.job_type === "module_search") {
    const cooldownRemaining = taobaoSearchCooldownMs - (Date.now() - lastTaobaoSearchFinishedAt);
    if (cooldownRemaining > 0) {
      process.stdout.write(`[local-executor] waiting ${cooldownRemaining}ms before the next Taobao search\n`);
      await sleep(cooldownRemaining);
    }
    let raw;
    try {
      // get_current_tab is not a passive health check in Taobao Desktop: when its
      // internal login state is stale it navigates the app to the login page.
      // Keep each user-approved search to one stateful shopping tool call.
      raw = await taobaoClient.callTool("search_products", {
        keyword: String(payload.keyword ?? "").trim(),
        // Match the official skill's default route. The dedicated PC route can
        // redirect an otherwise logged-in desktop WebView to login.taobao.com.
        type: "all"
      }, operationSignal(signal, taobaoSearchTimeoutMs));
    } catch (error) {
      if (error instanceof ExecutorJobError) throw error;
      throw taobaoJobError(error, "搜索");
    } finally {
      lastTaobaoSearchFinishedAt = Date.now();
    }
    try {
      const result = normalizeTaobaoSearchEvidence(raw, {
        keyword: String(payload.keyword ?? "").trim(),
        moduleId: String(payload.module_id ?? "").trim()
      });
      result.evidence.source = "taobao-mcp";
      process.stdout.write(
        `[local-executor] verified ${result.candidates.length} Taobao candidates from MCP for ${job.id}\n`
      );
      return result;
    } catch (error) {
      throw new ExecutorJobError(error instanceof Error ? error.message : String(error), false);
    }
  }

  const productId = String(payload.product_id ?? "").trim();
  if (!productId) throw new ExecutorJobError("加购任务缺少商品 ID。", false);
  try {
    // As with search, do not probe get_current_tab first. add_to_cart owns its
    // authentication response and the circuit breaker handles a real auth error.
    const raw = await taobaoClient.callTool(
      "add_to_cart",
      { itemId: productId, sku: [] },
      operationSignal(signal, taobaoCartTimeoutMs)
    );
    return normalizeTaobaoCartResult(raw, productId);
  } catch (error) {
    if (error instanceof ExecutorJobError) throw error;
    throw taobaoJobError(error, "加购");
  }
}

async function heartbeat() {
  if (heartbeatInFlight) return;
  heartbeatInFlight = true;
  const jobId = leaseGuard.currentJobId;
  try {
    const payload = await api("/api/executor/heartbeat", {
      method: "POST",
      body: JSON.stringify({ current_job_id: jobId })
    });
    leaseGuard.acceptHeartbeat(jobId, payload.lease_renewed === true);
  } catch (error) {
    process.stderr.write(`[local-executor] heartbeat failed: ${error.message}\n`);
    leaseGuard.rejectHeartbeat(jobId);
  } finally {
    heartbeatInFlight = false;
  }
}

try {
  await verifyStartup();
} catch (error) {
  process.stderr.write(`[local-executor] startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
const heartbeatTimer = setInterval(() => {
  heartbeat().catch(() => undefined);
}, 15000);

async function loop() {
  process.stdout.write(`[local-executor] connected to ${apiBaseUrl}; polling every ${pollMs}ms\n`);
  await heartbeat();
  while (!stopped) {
    if (authenticationPaused) {
      await sleep(Math.max(pollMs, 5000));
      continue;
    }
    try {
      const { job } = await api("/api/executor/jobs/claim", { method: "POST", body: "{}" });
      if (!job) {
        await sleep(pollMs);
        continue;
      }
      const jobSignal = leaseGuard.start(job.id);
      process.stdout.write(`[local-executor] claimed ${job.job_type} ${job.id} (attempt ${job.attempts}/${job.max_attempts})\n`);
      let result;
      try {
        await heartbeat();
        if (leaseGuard.lossReason) throw new Error(leaseGuard.lossReason);
        const cached = await readCachedResult(job);
        result = cached ?? await executeJob(job, jobSignal);
        if (!cached) await cacheResult(job.id, result);
      } catch (error) {
        if (leaseGuard.lossReason) {
          process.stderr.write(
            `[local-executor] abandoned ${job.id} without callback because its lease is no longer owned: ${leaseGuard.lossReason}\n`
          );
          leaseGuard.clear(job.id);
          continue;
        }
        // The Taobao operation has stopped. Detach heartbeat renewal before the
        // terminal callback so a completed failure is not misreported as lease loss.
        leaseGuard.clear(job.id);
        await reportResult(job.id, {
          status: "failed",
          error: error.message,
          retryable: error instanceof ExecutorJobError ? error.retryable : true
        }).catch((resolveError) => {
          process.stderr.write(`[local-executor] failed to report ${job.id}: ${resolveError.message}\n`);
        });
        process.stderr.write(`[local-executor] job ${job.id} failed: ${error.message}\n`);
        if (error instanceof ExecutorJobError && error.code === "auth_required") {
          authenticationPaused = true;
          process.stderr.write(
            "[local-executor] authentication circuit breaker opened; no more jobs will be claimed until the executor is restarted after Taobao login\n"
          );
        }
        continue;
      }

      // From this point the local operation is immutable and cached. Result
      // acknowledgement no longer needs to keep the execution lease alive.
      leaseGuard.clear(job.id);
      if (result?.success === false) {
        await reportResult(job.id, {
          status: "failed",
          error: result.message || "淘宝工具返回失败"
        }).catch((error) => {
          process.stderr.write(`[local-executor] failed to report ${job.id}: ${error.message}\n`);
        });
        process.stderr.write(`[local-executor] job ${job.id} returned a failed result\n`);
      } else {
        try {
          await reportResult(job.id, { status: "completed", result });
          process.stdout.write(`[local-executor] completed ${job.id}\n`);
        } catch (error) {
          process.stderr.write(
            `[local-executor] result for ${job.id} is cached; server acknowledgement failed and will be replayed after lease recovery: ${error.message}\n`
          );
        }
      }
      // Keep the result ledger: an expired lease can replay acknowledgement without repeating Taobao actions.
    } catch (error) {
      process.stderr.write(`[local-executor] polling failed: ${error.message}\n`);
      await sleep(Math.max(pollMs, 3000));
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopped = true;
    clearInterval(heartbeatTimer);
    leaseGuard.stop(`worker received ${signal}`);
  });
}

await loop();
await taobaoClient.close().catch((error) => {
  process.stderr.write(`[local-executor] failed to close MCP session: ${error.message}\n`);
});
