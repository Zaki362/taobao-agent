import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import nextEnv from "@next/env";
import protocol from "../lib/runtime/executor-protocol.json" with { type: "json" };
import { ExecutorLeaseGuard } from "./executor-lease-guard.mjs";
import {
  isMcpReadinessError,
  isTaobaoLimitedBetaError,
  mcpReadinessBackoffMs,
  missingTaobaoCartTools,
  missingTaobaoDetailTools,
  missingTaobaoTools,
  shouldFallbackToTaobaoNativeCli
} from "./local-executor-readiness.mjs";
import { TaobaoMcpClient } from "./taobao-mcp-client.mjs";
import { TaobaoNativeCliClient } from "./taobao-native-cli-client.mjs";
import {
  buildTaobaoMcpSearchEvidence,
  buildUnavailableTaobaoMcpProductDetailEvidence,
  classifyTaobaoAuthentication,
  createPendingAuthenticationFailure,
  createPendingResultAcknowledgement,
  executorFailureDisposition,
  isTaobaoLoginError,
  isTrustedTaobaoDetailUrl,
  normalizeTaobaoCartResult,
  normalizeTaobaoMcpProductDetailEvidence,
  normalizeTaobaoSearchEvidence,
  PendingAuthenticationFailureCoordinator,
  PendingAuthenticationFailureStore,
  PendingResultAcknowledgementCoordinator,
  PendingResultAcknowledgementStore,
  prepareTaobaoCartAction
} from "./local-executor-utils.mjs";
import {
  isVercelProtectionError,
  safeMachineErrorMessage,
  vercelProtectedFetch
} from "./vercel-protection-bypass.mjs";

nextEnv.loadEnvConfig(process.cwd());

const apiBaseUrl = (process.env.SCENECART_API_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const deviceToken = process.env.SCENECART_DEVICE_TOKEN;
const taobaoMcpUrl = process.env.TAOBAO_NATIVE_MCP_URL || "http://127.0.0.1:3654/mcp";
const pollMs = Math.max(Number(process.env.EXECUTOR_POLL_MS || 2500), 500);
const taobaoSearchTimeoutMs = Math.max(Number(process.env.EXECUTOR_TAOBAO_SEARCH_TIMEOUT_MS || 60000), 15000);
const taobaoCartTimeoutMs = Math.max(Number(process.env.EXECUTOR_TAOBAO_CART_TIMEOUT_MS || 60000), 15000);
const taobaoSearchCooldownMs = Math.max(Number(process.env.EXECUTOR_TAOBAO_SEARCH_COOLDOWN_MS || 30000), 0);
const taobaoAuthRecoveryPollMs = Math.max(Number(process.env.EXECUTOR_TAOBAO_AUTH_RECOVERY_POLL_MS || 10000), 5000);
const taobaoAuthProbeTimeoutMs = Math.max(Number(process.env.EXECUTOR_TAOBAO_AUTH_PROBE_TIMEOUT_MS || 10000), 5000);
const taobaoReadinessProbeTimeoutMs = Math.max(Number(process.env.EXECUTOR_TAOBAO_READINESS_PROBE_TIMEOUT_MS || 10000), 3000);
const taobaoReadinessBackoffBaseMs = Math.max(Number(process.env.EXECUTOR_TAOBAO_READINESS_BACKOFF_BASE_MS || 2000), 250);
const taobaoReadinessBackoffMaxMs = Math.max(Number(process.env.EXECUTOR_TAOBAO_READINESS_BACKOFF_MAX_MS || 30000), taobaoReadinessBackoffBaseMs);
const taobaoSourceApp = process.env.TAOBAO_SOURCE_APP || "SceneCartAI";
const apiTimeoutMs = Math.max(Number(process.env.EXECUTOR_API_TIMEOUT_MS || 20000), 5000);
const resolveTimeoutMs = Math.max(Number(process.env.EXECUTOR_RESOLVE_TIMEOUT_MS || 60000), apiTimeoutMs);
const resolveRetryBaseMs = Math.max(Number(process.env.EXECUTOR_RESOLVE_RETRY_BASE_MS || 750), 50);
const resultAcknowledgementRetryMs = Math.max(
  Number(process.env.EXECUTOR_RESULT_ACK_RETRY_MS || 3000),
  250
);
const leaseFailureLimit = Math.max(Number(process.env.EXECUTOR_LEASE_FAILURE_LIMIT || 3), 1);
const executorStateDir = process.env.EXECUTOR_STATE_DIR
  ? path.resolve(process.env.EXECUTOR_STATE_DIR)
  : path.join(process.cwd(), ".data", "local-executor");
const resultDir = path.join(executorStateDir, "results");
const pendingAuthFailurePath = path.join(
  executorStateDir,
  "pending-auth-failure.json"
);
const pendingResultAcknowledgementPath = path.join(
  executorStateDir,
  "pending-result-acknowledgement.json"
);
const executorProtocolVersion = protocol.version;
if (!deviceToken) {
  throw new Error("SCENECART_DEVICE_TOKEN is required. Provision the fixed-owner device with npm run executor:provision first.");
}

let heartbeatInFlight = null;
let stopped = false;
let authenticationPaused = false;
let mcpUnavailable = true;
let mcpReadinessAttempt = 0;
let executorCapabilities = [];
let availableTaobaoToolNames = new Set();
let taobaoSearchTransport = "http_mcp";
let fatalApiError = null;
let lastAuthenticationProbeAt = 0;
let lastTaobaoSearchFinishedAt = 0;
const leaseGuard = new ExecutorLeaseGuard({
  failureLimit: leaseFailureLimit,
  onLeaseLost: ({ jobId, reason }) => {
    process.stderr.write(`[local-executor] lease lost for ${jobId}: ${safeMachineErrorMessage(reason)}; stopping local execution\n`);
  }
});
const pendingAuthFailureStore = new PendingAuthenticationFailureStore(pendingAuthFailurePath);
const pendingAuthFailureCoordinator = new PendingAuthenticationFailureCoordinator(pendingAuthFailureStore);
const pendingResultAcknowledgementStore = new PendingResultAcknowledgementStore(
  pendingResultAcknowledgementPath
);
const pendingResultAcknowledgementCoordinator = new PendingResultAcknowledgementCoordinator(
  pendingResultAcknowledgementStore
);

class ExecutorJobError extends Error {
  constructor(message, retryable = true, code = "operation_failed") {
    super(message);
    this.name = "ExecutorJobError";
    this.retryable = retryable;
    this.code = code;
  }
}

class ExecutorApiError extends Error {
  constructor(message, status, code = "api_error") {
    super(message);
    this.name = "ExecutorApiError";
    this.status = status;
    this.code = code;
  }
}

class FatalExecutorApiError extends ExecutorApiError {
  constructor(message, status, code) {
    super(message, status, code);
    this.name = "FatalExecutorApiError";
  }
}

function isDiscardableResultAcknowledgementError(error) {
  return error instanceof ExecutorApiError &&
    error.status === 409 &&
    ["job_lease_lost", "job_superseded", "stale_job_result"].includes(error.code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(path, options = {}) {
  const url = `${apiBaseUrl}${path}`;
  let response;
  try {
    response = await vercelProtectedFetch(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(apiTimeoutMs),
      headers: {
        Authorization: `Bearer ${deviceToken}`,
        "Content-Type": "application/json",
        "X-SceneCart-Executor-Protocol": executorProtocolVersion,
        ...(options.headers || {})
      }
    });
  } catch (error) {
    if (isVercelProtectionError(error)) {
      throw new FatalExecutorApiError(
        safeMachineErrorMessage(error),
        error.status,
        error.code
      );
    }
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error || `${path} failed with ${response.status}`;
    if (response.status === 401 || response.status === 426) {
      throw new FatalExecutorApiError(message, response.status, payload.code);
    }
    throw new ExecutorApiError(message, response.status, payload.code);
  }
  return payload;
}

async function verifyStartup() {
  const response = await vercelProtectedFetch(`${apiBaseUrl}/api/runtime/health`, {
    signal: AbortSignal.timeout(apiTimeoutMs)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status !== "healthy") {
    throw new Error(payload.error || `场景购 API health check failed with ${response.status}`);
  }
  if (payload.executor_protocol_version !== executorProtocolVersion) {
    throw new Error(
      `执行器协议不兼容：本地=${executorProtocolVersion}，服务端=${payload.executor_protocol_version ?? "未知"}。请更新项目代码后重启。`
    );
  }
  const heartbeatPayload = await api("/api/executor/heartbeat", {
    method: "POST",
    // Never advertise the Worker as online until tools/list proves that this
    // exact Taobao Desktop MCP session is ready.
    body: authenticationPaused
      ? JSON.stringify({ executor_state: "authentication_required" })
      : JSON.stringify({ executor_state: "mcp_unavailable" })
  });
  const capabilities = Array.isArray(heartbeatPayload.device?.capabilities)
    ? heartbeatPayload.device.capabilities
    : [];
  if (!capabilities.includes("module_search")) {
    throw new Error("设备令牌没有 module_search 能力，请使用运维命令 executor:provision -- --rotate 轮换授权。");
  }
  if (heartbeatPayload.executor_state === "authentication_required") {
    authenticationPaused = true;
    lastAuthenticationProbeAt = 0;
    process.stderr.write(
      "[local-executor] restored authentication pause; waiting for local Taobao login verification\n"
    );
  }
  if (await pendingAuthFailureCoordinator.current()) {
    const callbackConfirmed = await flushPendingAuthenticationFailure();
    if (!callbackConfirmed) {
      throw new Error(
        "登录失败回调尚未获得服务端终态确认；执行器保持暂停且不会连接淘宝工具。"
      );
    }
  }
  if (heartbeatPayload.protocol_version !== executorProtocolVersion) {
    throw new Error("服务端未确认当前执行器协议，请更新项目代码后重启。");
  }
  const startupStandby = await api("/api/executor/startup", {
    method: "POST",
    body: "{}"
  });
  if (
    startupStandby.startup_standby_established !== true ||
    startupStandby.protocol_version !== executorProtocolVersion
  ) {
    throw new Error("服务端未建立执行器启动待命状态；为避免自动执行历史任务，Worker 已停止。");
  }
  const pausedWorkflowCount = Number(startupStandby.paused_workflows ?? 0);
  process.stdout.write(
    pausedWorkflowCount > 0
      ? `[local-executor] startup standby established; paused ${pausedWorkflowCount} historical workflow(s). Open the 场景购 page and click 继续搜索 to resume\n`
      : "[local-executor] startup standby established; no historical workflow requires confirmation\n"
  );
  process.stdout.write(
    `[local-executor] API and durability checks passed; runtime=${payload.runtime_store}; backend=${payload.effective_executor_backend}; capabilities=${capabilities.join(",")}\n`
  );
  return capabilities;
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
const taobaoCliClient = new TaobaoNativeCliClient({
  sourceApp: taobaoSourceApp,
  timeoutMs: taobaoSearchTimeoutMs
});

function activateTaobaoCliSearchFallback(reason) {
  const changed = taobaoSearchTransport !== "native_cli";
  taobaoSearchTransport = "native_cli";
  availableTaobaoToolNames = new Set(["search_products", "list_available_pages"]);
  taobaoClient.resetSession();
  if (changed) {
    process.stderr.write(
      `[local-executor] HTTP MCP search unavailable; using the official Taobao CLI for read-only searches: ${safeMachineErrorMessage(reason)}\n`
    );
  }
}

function enterMcpUnavailable(error) {
  const wasUnavailable = mcpUnavailable;
  mcpUnavailable = true;
  taobaoClient.resetSession();
  if (!wasUnavailable && error) {
    process.stderr.write(
      `[local-executor] Taobao MCP readiness circuit opened: ${safeMachineErrorMessage(error)}\n`
    );
  }
}

async function waitForMcpReadiness() {
  while (!stopped && !authenticationPaused && mcpUnavailable) {
    const unavailableHeartbeat = await heartbeat({ executorState: "mcp_unavailable", force: true });
    if (unavailableHeartbeat?.executor_state === "authentication_required") {
      authenticationPaused = true;
      lastAuthenticationProbeAt = 0;
      return false;
    }
    if (fatalApiError) return false;

    try {
      const tools = await taobaoClient.listTools(
        operationSignal(undefined, taobaoReadinessProbeTimeoutMs)
      );
      const missingTools = missingTaobaoTools(tools, executorCapabilities);
      if (missingTools.length > 0) {
        throw new Error(`淘宝桌面版 MCP 缺少必需工具：${missingTools.join("、")}`);
      }
      const missingCartTools = executorCapabilities.includes("add_to_cart")
        ? missingTaobaoCartTools(tools)
        : [];
      if (missingCartTools.length > 0) {
        process.stderr.write(
          `[local-executor] search is ready; optional cart tools are unavailable: ${missingCartTools.join(",")}\n`
        );
      }
      availableTaobaoToolNames = new Set(tools.map((tool) => tool?.name).filter(Boolean));
      taobaoSearchTransport = "http_mcp";
      const missingDetailTools = missingTaobaoDetailTools(tools);
      if (missingDetailTools.length > 0) {
        process.stderr.write(
          `[local-executor] search is ready; preferred-product detail evidence will be unavailable (missing ${missingDetailTools.join(",")})\n`
        );
      }

      const onlineHeartbeat = await heartbeat({ executorState: "online", force: true });
      if (fatalApiError) return false;
      if (onlineHeartbeat?.executor_state === "authentication_required") {
        authenticationPaused = true;
        lastAuthenticationProbeAt = 0;
        return false;
      }
      if (onlineHeartbeat?.executor_state !== "online") {
        throw new Error("服务端尚未确认本地执行器上线");
      }

      mcpUnavailable = false;
      mcpReadinessAttempt = 0;
      process.stdout.write(
        `[local-executor] Taobao MCP ready; tools=${tools.map((tool) => tool?.name).filter(Boolean).join(",")}\n`
      );
      return true;
    } catch (httpError) {
      if (httpError instanceof FatalExecutorApiError || fatalApiError || stopped) return false;
      try {
        await taobaoCliClient.probeSearchReadiness(
          operationSignal(undefined, taobaoReadinessProbeTimeoutMs)
        );
        activateTaobaoCliSearchFallback(httpError);
        const onlineHeartbeat = await heartbeat({ executorState: "online", force: true });
        if (fatalApiError) return false;
        if (onlineHeartbeat?.executor_state === "authentication_required") {
          authenticationPaused = true;
          lastAuthenticationProbeAt = 0;
          return false;
        }
        if (onlineHeartbeat?.executor_state !== "online") {
          throw new Error("服务端尚未确认本地执行器的 CLI 搜索兜底上线");
        }
        mcpUnavailable = false;
        mcpReadinessAttempt = 0;
        process.stdout.write(
          "[local-executor] Taobao official CLI ready; read-only search fallback is active; product detail and cart remain fail-closed without HTTP MCP\n"
        );
        return true;
      } catch (cliError) {
        if (cliError instanceof FatalExecutorApiError || fatalApiError || stopped) return false;
        const combinedError = new Error(
          `HTTP MCP: ${safeMachineErrorMessage(httpError)}; 官方 CLI: ${safeMachineErrorMessage(cliError)}`
        );
        enterMcpUnavailable(combinedError);
      }
      const delayMs = mcpReadinessBackoffMs(mcpReadinessAttempt, {
        baseMs: taobaoReadinessBackoffBaseMs,
        maxMs: taobaoReadinessBackoffMaxMs
      });
      mcpReadinessAttempt += 1;
      process.stderr.write(
        `[local-executor] Taobao search transports unavailable; retrying readiness in ${delayMs}ms\n`
      );
      await sleep(delayMs);
    }
  }
  return !mcpUnavailable;
}

async function readCachedResult(job) {
  try {
    const result = JSON.parse(await fs.readFile(path.join(resultDir, `${job.id}.json`), "utf-8"));
    if (
      job.job_type === "module_search" &&
      (
        result?.evidence?.schema !== "scenecart.taobao-mcp-search-evidence/v1" ||
        result?.evidence?.source !== "taobao-mcp"
      )
    ) {
      process.stderr.write(
        `[local-executor] ignored pre-v2 or unverified search cache for ${job.id}\n`
      );
      return null;
    }
    return result;
  } catch {
    return null;
  }
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
      if (
        error instanceof FatalExecutorApiError ||
        isDiscardableResultAcknowledgementError(error)
      ) throw error;
      await sleep(attempt * resolveRetryBaseMs);
    }
  }
  throw lastError;
}

async function flushPendingResultAcknowledgement() {
  const pending = await pendingResultAcknowledgementCoordinator.current();
  if (!pending) return true;
  if (
    leaseGuard.currentJobId !== pending.job_id ||
    leaseGuard.currentLeaseToken !== pending.lease_token
  ) {
    leaseGuard.start(pending.job_id, pending.lease_token);
  }

  let outcome;
  try {
    outcome = await pendingResultAcknowledgementCoordinator.deliver(
      (callback) => reportResult(callback.job_id, {
        status: "completed",
        result: callback.result,
        lease_token: callback.lease_token
      }),
      {
        isDiscardableError: isDiscardableResultAcknowledgementError,
        isFatalError: (error) => error instanceof FatalExecutorApiError
      }
    );
  } catch (error) {
    if (error instanceof FatalExecutorApiError) {
      fatalApiError = error;
      stopped = true;
      leaseGuard.stop(`fatal API ${error.status}`);
      process.stderr.write(
        `[local-executor] fatal result acknowledgement response ${error.status}; handing restart to supervisor: ${safeMachineErrorMessage(error)}\n`
      );
      return false;
    }
    throw error;
  }

  if (outcome.state === "confirmed" || outcome.state === "discarded") {
    leaseGuard.clear(pending.job_id);
    if (outcome.state === "discarded") {
      process.stderr.write(
        `[local-executor] discarded stale or superseded result acknowledgement for ${pending.job_id}\n`
      );
    } else {
      process.stdout.write(
        `[local-executor] server confirmed durable result acknowledgement for ${pending.job_id}\n`
      );
    }
    if (outcome.cleanup_error) {
      process.stderr.write(
        `[local-executor] confirmed ${pending.job_id}, but its local acknowledgement ledger cleanup will be retried after restart: ${safeMachineErrorMessage(outcome.cleanup_error)}\n`
      );
    }
    return true;
  }

  process.stderr.write(
    `[local-executor] result acknowledgement for ${pending.job_id} remains pending; no new Taobao action will be claimed: ${safeMachineErrorMessage(outcome.error || "server did not confirm completed")}\n`
  );
  return false;
}

async function flushPendingAuthenticationFailure() {
  const pending = await pendingAuthFailureCoordinator.current();
  if (!pending) return true;

  // The server-side callback recovery path requires the authenticated device
  // itself to be paused. This heartbeat never renews or releases another lease.
  const heartbeatPayload = await heartbeat({
    executorState: "authentication_required",
    force: true
  });
  if (heartbeatPayload?.executor_state !== "authentication_required") return false;

  const outcome = await pendingAuthFailureCoordinator.deliver(
    (callback) => reportResult(callback.job_id, {
      status: "failed",
      error: callback.error,
      retryable: false,
      failure_kind: "authentication_required",
      lease_token: callback.lease_token
    })
  );
  if (outcome.state !== "confirmed") {
    process.stderr.write(
      `[local-executor] authentication failure callback for ${pending.job_id} remains pending: ${safeMachineErrorMessage(outcome.error || "server did not confirm failed")}\n`
    );
    return false;
  }
  process.stdout.write(
    `[local-executor] server confirmed authentication failure for ${pending.job_id}; callback ledger cleared\n`
  );
  return true;
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
  if (isTaobaoLimitedBetaError(output)) {
    return new ExecutorJobError(
      "淘宝 HTTP MCP 返回了内测限制，官方 CLI 兜底也未能完成搜索。",
      false,
      "taobao_limited_beta"
    );
  }
  if (/Tool 执行层未就绪|应用已加载完成|连接失败|cli-rpc\.sock|ECONNREFUSED/i.test(output)) {
    return new ExecutorJobError(
      "淘宝桌面版工具执行层暂未就绪，请保持客户端主界面打开后重试。",
      true,
      "mcp_unavailable"
    );
  }
  if (/timed out|timeout|SIGTERM|SIGKILL/i.test(output)) {
    return new ExecutorJobError(`淘宝${operation}在限定时间内未完成。`, true);
  }
  if (/fetch failed|ECONNREFUSED|MCP.*请求失败|会话 ID/i.test(output)) {
    return new ExecutorJobError(
      "淘宝桌面版 MCP 暂不可达，请保持客户端运行后重试。",
      true,
      "mcp_unavailable"
    );
  }
  return new ExecutorJobError(output ? output.slice(0, 1000) : `淘宝 MCP 未返回${operation}结果。`, true);
}

async function probeTaobaoAuthentication() {
  try {
    // This probe is deliberately restricted to the authentication-paused state.
    // In that state Taobao has already opened its login page, so reading the
    // current tab cannot consume or duplicate a user-approved shopping action.
    const raw = taobaoSearchTransport === "native_cli"
      ? await taobaoCliClient.getCurrentTab(
        operationSignal(undefined, taobaoAuthProbeTimeoutMs)
      )
      : await taobaoClient.callTool(
        "get_current_tab",
        {},
        operationSignal(undefined, taobaoAuthProbeTimeoutMs)
      );
    return classifyTaobaoAuthentication(raw);
  } catch (error) {
    if (isTaobaoLoginError(errorOutput(error))) return "authentication_required";
    throw error;
  }
}

async function executeJob(job, signal) {
  const payload = job.payload || {};
  if (job.job_type === "product_detail") {
    const context = {
      sourceApp: taobaoSourceApp,
      jobId: job.id,
      searchJobId: String(payload.search_job_id ?? "").trim(),
      moduleId: String(payload.module_id ?? "").trim(),
      workflowRunId: String(payload.workflow_run_id ?? "").trim(),
      productId: String(payload.product_id ?? "").trim(),
      detailUrl: String(payload.detail_url ?? "").trim(),
      factTerms: Array.isArray(payload.fact_terms)
        ? payload.fact_terms.filter((term) => typeof term === "string")
        : []
    };
    if (
      !context.searchJobId || !context.moduleId || !context.workflowRunId ||
      !context.productId || !isTrustedTaobaoDetailUrl(context.detailUrl)
    ) {
      throw new ExecutorJobError("详情任务上下文或淘宝详情链接无效。", false);
    }
    const toolList = [...availableTaobaoToolNames].map((name) => ({ name }));
    const missingTools = missingTaobaoDetailTools(toolList);
    if (missingTools.length > 0) {
      return {
        detail_evidence: buildUnavailableTaobaoMcpProductDetailEvidence(
          context,
          `淘宝桌面版未提供详情读取工具：${missingTools.join("、")}`
        )
      };
    }

    const toolsUsed = [];
    try {
      const navigation = await taobaoClient.callTool(
        "navigate_to_url",
        { url: context.detailUrl },
        operationSignal(signal, taobaoSearchTimeoutMs)
      );
      toolsUsed.push("navigate_to_url");
      if (isTaobaoLoginError(errorOutput(navigation))) {
        return {
          detail_evidence: buildUnavailableTaobaoMcpProductDetailEvidence(
            context,
            "淘宝详情读取时登录态不可用；搜索结果已保留，不会自动重放。",
            toolsUsed
          )
        };
      }
      const pageContent = await taobaoClient.callTool(
        "read_page_content",
        { maxLength: 5000 },
        operationSignal(signal, taobaoSearchTimeoutMs)
      );
      toolsUsed.push("read_page_content");
      if (isTaobaoLoginError(errorOutput(pageContent))) {
        return {
          detail_evidence: buildUnavailableTaobaoMcpProductDetailEvidence(
            context,
            "淘宝详情读取时登录态不可用；搜索结果已保留，不会自动重放。",
            toolsUsed
          )
        };
      }
      return {
        detail_evidence: normalizeTaobaoMcpProductDetailEvidence(pageContent, {
          ...context,
          capturedAt: new Date().toISOString()
        })
      };
    } catch (error) {
      if (isMcpReadinessError(error)) enterMcpUnavailable(error);
      return {
        detail_evidence: buildUnavailableTaobaoMcpProductDetailEvidence(
          { ...context, capturedAt: new Date().toISOString() },
          error instanceof Error ? error.message : String(error),
          toolsUsed
        )
      };
    }
  }
  if (job.job_type === "module_search") {
    const keyword = String(payload.keyword ?? "").trim();
    const moduleId = String(payload.module_id ?? "").trim();
    const workflowRunId = String(payload.workflow_run_id ?? "").trim();
    if (!keyword || !moduleId || !workflowRunId) {
      throw new ExecutorJobError("搜索任务缺少 keyword、module_id 或 workflow_run_id，已停止执行。", false);
    }
    const cooldownRemaining = taobaoSearchCooldownMs - (Date.now() - lastTaobaoSearchFinishedAt);
    if (cooldownRemaining > 0) {
      process.stdout.write(`[local-executor] waiting ${cooldownRemaining}ms before the next Taobao search\n`);
      await sleep(cooldownRemaining);
    }
    let raw;
    try {
      if (taobaoSearchTransport === "native_cli") {
        raw = await taobaoCliClient.searchProducts(
          { keyword, type: "all" },
          operationSignal(signal, taobaoSearchTimeoutMs)
        );
      } else {
        try {
          // get_current_tab is not a passive health check in Taobao Desktop: when its
          // internal login state is stale it navigates the app to the login page.
          // Keep each user-approved search to one stateful shopping tool call.
          raw = await taobaoClient.callTool("search_products", {
            keyword,
            // Match the official skill's default route. The dedicated PC route can
            // redirect an otherwise logged-in desktop WebView to login.taobao.com.
            type: "all"
          }, operationSignal(signal, taobaoSearchTimeoutMs));
        } catch (httpError) {
          if (!shouldFallbackToTaobaoNativeCli(httpError)) throw httpError;
          try {
            raw = await taobaoCliClient.searchProducts(
              { keyword, type: "all" },
              operationSignal(signal, taobaoSearchTimeoutMs)
            );
            activateTaobaoCliSearchFallback(httpError);
          } catch (cliError) {
            throw taobaoJobError(cliError, "搜索");
          }
        }
      }
    } catch (error) {
      if (error instanceof ExecutorJobError) throw error;
      throw taobaoJobError(error, "搜索");
    } finally {
      lastTaobaoSearchFinishedAt = Date.now();
    }
    try {
      const result = normalizeTaobaoSearchEvidence(raw, {
        keyword,
        moduleId
      });
      result.evidence = buildTaobaoMcpSearchEvidence({
        sourceApp: taobaoSourceApp,
        jobId: job.id,
        moduleId,
        workflowRunId,
        keyword,
        capturedAt: new Date().toISOString(),
        rawResultCount: result.evidence.raw_result_count,
        transport: taobaoSearchTransport
      });
      process.stdout.write(
        `[local-executor] verified ${result.candidates.length} Taobao candidates via ${taobaoSearchTransport === "native_cli" ? "official CLI" : "HTTP MCP"} for ${job.id}\n`
      );
      return result;
    } catch (error) {
      throw new ExecutorJobError(error instanceof Error ? error.message : String(error), false);
    }
  }

  const productId = String(payload.product_id ?? "").trim();
  if (!productId) throw new ExecutorJobError("加购任务缺少商品 ID。", false);
  try {
    // The official Taobao contract requires SKU evidence before every cart
    // mutation. Do not infer a default variant when the task has no user choice.
    const skuRaw = await taobaoClient.callTool(
      "get_product_skus",
      { itemId: productId },
      operationSignal(signal, taobaoCartTimeoutMs)
    );
    const cartAction = prepareTaobaoCartAction(skuRaw, payload, productId);
    if (cartAction.action === "sku_selection_required") return cartAction.result;

    const raw = await taobaoClient.callTool(
      "add_to_cart",
      cartAction.arguments,
      operationSignal(signal, taobaoCartTimeoutMs)
    );
    return normalizeTaobaoCartResult(raw, productId);
  } catch (error) {
    if (error instanceof ExecutorJobError) throw error;
    throw taobaoJobError(error, "加购");
  }
}

async function heartbeat(options = {}) {
  if (heartbeatInFlight) {
    if (options.force !== true) return heartbeatInFlight;
    await heartbeatInFlight.catch(() => undefined);
  }
  const jobId = leaseGuard.currentJobId;
  const leaseToken = leaseGuard.currentLeaseToken;
  const executorState = options.executorState ?? (
    authenticationPaused
      ? "authentication_required"
      : mcpUnavailable
        ? "mcp_unavailable"
        : "online"
  );
  const requestBody = {
    current_job_id: jobId,
    ...(jobId ? { lease_token: leaseToken } : {}),
    executor_state: executorState,
    ...(options.authenticationFailure
      ? {
          authentication_failure: {
            job_id: options.authenticationFailure.job_id,
            lease_token: options.authenticationFailure.lease_token,
            error: options.authenticationFailure.error
          }
        }
      : {}),
    ...(options.authenticationRecoveryVerified === true
      ? { authentication_recovery_verified: true }
      : {})
  };
  const request = (async () => {
    try {
      const payload = await api("/api/executor/heartbeat", {
        method: "POST",
        body: JSON.stringify(requestBody)
      });
      if (jobId) leaseGuard.acceptHeartbeat(jobId, leaseToken, payload.lease_renewed === true);
      return payload;
    } catch (error) {
      process.stderr.write(`[local-executor] heartbeat failed: ${safeMachineErrorMessage(error)}\n`);
      if (jobId) leaseGuard.rejectHeartbeat(jobId, leaseToken);
      if (error instanceof FatalExecutorApiError) {
        fatalApiError = error;
        stopped = true;
        leaseGuard.stop(`fatal API ${error.status}`);
      }
      return null;
    }
  })();
  heartbeatInFlight = request;
  try {
    return await request;
  } finally {
    if (heartbeatInFlight === request) heartbeatInFlight = null;
  }
}

async function recoverTaobaoAuthentication() {
  // Never inspect the restored login state while an earlier Taobao action could
  // still return to the pending queue. Terminal failure acknowledgement wins.
  if (!await flushPendingAuthenticationFailure()) return false;

  const now = Date.now();
  if (now - lastAuthenticationProbeAt < taobaoAuthRecoveryPollMs) return false;
  lastAuthenticationProbeAt = now;

  let state;
  try {
    state = await probeTaobaoAuthentication();
  } catch (error) {
    process.stderr.write(
      `[local-executor] authentication recovery probe failed: ${safeMachineErrorMessage(error)}\n`
    );
    await heartbeat({ executorState: "authentication_required", force: true });
    return false;
  }
  if (state !== "authenticated") {
    await heartbeat({ executorState: "authentication_required", force: true });
    return false;
  }

  try {
    if (taobaoSearchTransport === "native_cli") {
      await taobaoCliClient.probeSearchReadiness(
        operationSignal(undefined, taobaoReadinessProbeTimeoutMs)
      );
      availableTaobaoToolNames = new Set(["search_products", "list_available_pages"]);
    } else {
      const tools = await taobaoClient.listTools(
        operationSignal(undefined, taobaoReadinessProbeTimeoutMs)
      );
      const missingTools = missingTaobaoTools(tools, executorCapabilities);
      if (missingTools.length > 0) {
        throw new Error(`淘宝桌面版 MCP 缺少必需工具：${missingTools.join("、")}`);
      }
      availableTaobaoToolNames = new Set(tools.map((tool) => tool?.name).filter(Boolean));
    }
  } catch (error) {
    enterMcpUnavailable(error);
    process.stderr.write(
      `[local-executor] login is available but Taobao search tools are not ready yet: ${safeMachineErrorMessage(error)}\n`
    );
    await heartbeat({ executorState: "authentication_required", force: true });
    return false;
  }

  const payload = await heartbeat({
    executorState: "online",
    authenticationRecoveryVerified: true,
    force: true
  });
  if (payload?.executor_state !== "online") return false;
  authenticationPaused = false;
  mcpUnavailable = false;
  mcpReadinessAttempt = 0;
  lastTaobaoSearchFinishedAt = 0;
  process.stdout.write(
    "[local-executor] Taobao authentication recovered; job claiming has resumed and the failed action remains paused until user confirmation\n"
  );
  return true;
}

try {
  const pendingResultAcknowledgement = await pendingResultAcknowledgementCoordinator.restore();
  if (pendingResultAcknowledgement) {
    leaseGuard.start(
      pendingResultAcknowledgement.job_id,
      pendingResultAcknowledgement.lease_token
    );
    process.stderr.write(
      `[local-executor] restored pending result acknowledgement for ${pendingResultAcknowledgement.job_id}; no Taobao action will run before it is terminally acknowledged\n`
    );
  }
  const pendingAuthenticationFailure = await pendingAuthFailureCoordinator.restore();
  if (pendingAuthenticationFailure) {
    authenticationPaused = true;
    process.stderr.write(
      `[local-executor] restored pending authentication failure callback for ${pendingAuthenticationFailure.job_id}\n`
    );
  }
  executorCapabilities = await verifyStartup();
} catch (error) {
  process.stderr.write(`[local-executor] startup failed: ${safeMachineErrorMessage(error)}\n`);
  process.exit(1);
}
const heartbeatTimer = setInterval(() => {
  heartbeat().catch(() => undefined);
}, 15000);

async function loop() {
  process.stdout.write(`[local-executor] connected to ${apiBaseUrl}; polling every ${pollMs}ms\n`);
  await heartbeat();
  while (!stopped) {
    try {
      if (!await flushPendingResultAcknowledgement()) {
        if (stopped) break;
        await heartbeat({ force: true });
        await sleep(resultAcknowledgementRetryMs);
        continue;
      }
    } catch (error) {
      process.stderr.write(
        `[local-executor] result acknowledgement recovery failed closed: ${safeMachineErrorMessage(error)}\n`
      );
      await sleep(resultAcknowledgementRetryMs);
      continue;
    }
    if (authenticationPaused) {
      await recoverTaobaoAuthentication();
      await sleep(Math.max(pollMs, 5000));
      continue;
    }
    if (mcpUnavailable) {
      await waitForMcpReadiness();
      if (mcpUnavailable || authenticationPaused) continue;
    }
    try {
      const { job } = await api("/api/executor/jobs/claim", {
        method: "POST",
        body: JSON.stringify({
          transport: taobaoSearchTransport,
          available_tools: [...availableTaobaoToolNames].sort()
        })
      });
      if (!job) {
        await sleep(pollMs);
        continue;
      }
      const jobSignal = leaseGuard.start(job.id, job.lease_token);
      process.stdout.write(`[local-executor] claimed ${job.job_type} ${job.id} (attempt ${job.attempts}/${job.max_attempts})\n`);
      let result;
      let resultCached = false;
      try {
        await heartbeat();
        if (leaseGuard.lossReason) throw new Error(leaseGuard.lossReason);
        const cached = await readCachedResult(job);
        resultCached = Boolean(cached);
        result = cached ?? await executeJob(job, jobSignal);
      } catch (error) {
        const authenticationRequired = error instanceof ExecutorJobError && error.code === "auth_required";
        const readinessFailure =
          error instanceof ExecutorJobError &&
          error.retryable &&
          isMcpReadinessError(error);
        if (readinessFailure) enterMcpUnavailable(error);
        let authenticationDurabilityEstablished = !authenticationRequired;
        const failureDisposition = executorFailureDisposition({
          authenticationRequired,
          leaseLost: Boolean(leaseGuard.lossReason)
        });
        if (failureDisposition === "abandon_lost_lease") {
          process.stderr.write(
            `[local-executor] abandoned ${job.id} without callback because its lease is no longer owned: ${safeMachineErrorMessage(leaseGuard.lossReason)}\n`
          );
          leaseGuard.clear(job.id);
          continue;
        }
        if (failureDisposition === "persist_authentication_failure") {
          authenticationPaused = true;
          lastAuthenticationProbeAt = 0;
          const errorMessage = `[${error.code}] ${error.message}`;
          const callback = pendingAuthFailureCoordinator.hold(
            createPendingAuthenticationFailure(job, errorMessage)
          );
          let localWalPersisted = false;
          let serverHoldPersisted = false;
          while (!stopped && !authenticationDurabilityEstablished) {
            // The local callback is the first write-ahead record. A hung API
            // request can then be killed safely because the next Worker restores
            // this exact callback before probing login or claiming another Job.
            const persistence = await pendingAuthFailureCoordinator.persistHeld();
            localWalPersisted ||= persistence.persisted;
            if (!persistence.persisted) {
              process.stderr.write(
                `[local-executor] authentication callback ledger write failed; attempting the durable server hold while the lease remains attached: ${safeMachineErrorMessage(persistence.error)}\n`
              );
            }

            const holdPayload = await heartbeat({
              executorState: "authentication_required",
              authenticationFailure: callback,
              force: true
            });
            serverHoldPersisted ||=
              holdPayload?.authentication_hold_persisted === true ||
              holdPayload?.authentication_failure_acknowledged === true;
            if (holdPayload?.authentication_failure_acknowledged === true) {
              await pendingAuthFailureCoordinator.deliver(async () => holdPayload);
            }
            authenticationDurabilityEstablished = localWalPersisted || serverHoldPersisted;
            if (!authenticationDurabilityEstablished) {
              process.stderr.write(
                "[local-executor] neither authentication WAL nor server hold is durable; retaining the lease and retrying fail-closed\n"
              );
              // If the API is reachable but the hold endpoint was rejected,
              // renew only this already-running lease. The Worker remains inside
              // this fail-closed branch and cannot claim another Job.
              const renewal = await heartbeat({ executorState: "online", force: true });
              serverHoldPersisted ||= renewal?.authentication_hold_active === true;
              authenticationDurabilityEstablished = serverHoldPersisted;
              if (!authenticationDurabilityEstablished) await sleep(1000);
            }
          }
        }
        if (authenticationRequired && !authenticationDurabilityEstablished) {
          process.stderr.write(
            `[local-executor] stopped before authentication durability was established for ${job.id}; lease was not detached\n`
          );
          continue;
        }
        // The Taobao operation has stopped. Detach heartbeat renewal before the
        // terminal callback so a completed failure is not misreported as lease loss.
        leaseGuard.clear(job.id);
        if (authenticationRequired) {
          await flushPendingAuthenticationFailure();
        } else {
          await reportResult(job.id, {
            status: "failed",
            error: error instanceof ExecutorJobError
              ? `[${error.code}] ${error.message}`
              : error.message,
            retryable: error instanceof ExecutorJobError ? error.retryable : true,
            lease_token: job.lease_token
          }).catch((resolveError) => {
            process.stderr.write(`[local-executor] failed to report ${job.id}: ${safeMachineErrorMessage(resolveError)}\n`);
          });
        }
        process.stderr.write(`[local-executor] job ${job.id} failed: ${safeMachineErrorMessage(error)}\n`);
        if (authenticationRequired) {
          process.stderr.write(
            "[local-executor] authentication circuit breaker opened; no jobs will be claimed until Taobao login is verified locally\n"
          );
        } else if (readinessFailure) {
          process.stderr.write(
            "[local-executor] MCP readiness circuit breaker opened; no more jobs will be claimed until tools/list succeeds\n"
          );
        }
        continue;
      }

      if (result?.success === false) {
        leaseGuard.clear(job.id);
        const resultError = result.code
          ? `[${result.code}] ${result.message || "淘宝工具返回失败"}`
          : result.message || "淘宝工具返回失败";
        await reportResult(job.id, {
          status: "failed",
          error: resultError,
          retryable: result.retryable !== false,
          lease_token: job.lease_token
        }).catch((error) => {
          process.stderr.write(`[local-executor] failed to report ${job.id}: ${safeMachineErrorMessage(error)}\n`);
        });
        process.stderr.write(`[local-executor] job ${job.id} returned a failed result\n`);
      } else {
        const callback = pendingResultAcknowledgementCoordinator.hold(
          createPendingResultAcknowledgement(job, result)
        );
        const persistence = await pendingResultAcknowledgementCoordinator.persistHeld();
        if (!persistence.persisted) {
          process.stderr.write(
            `[local-executor] successful ${job.job_type} result for ${job.id} remains fail-closed in memory because its acknowledgement WAL could not be written; automatic replay is forbidden: ${safeMachineErrorMessage(persistence.error)}\n`
          );
        }
        const acknowledged = await flushPendingResultAcknowledgement();
        if (acknowledged) {
          process.stdout.write(`[local-executor] completed ${job.id}\n`);
        } else {
          process.stderr.write(
            `[local-executor] successful result for ${callback.job_id} ${resultCached ? "was restored from the legacy cache" : "is stored in the acknowledgement WAL"}; retrying without repeating the Taobao action\n`
          );
        }
      }
    } catch (error) {
      if (error instanceof FatalExecutorApiError) {
        fatalApiError = error;
        stopped = true;
        leaseGuard.stop(`fatal API ${error.status}`);
        process.stderr.write(
          `[local-executor] fatal API response ${error.status}; handing restart to supervisor: ${safeMachineErrorMessage(error)}\n`
        );
        break;
      }
      process.stderr.write(`[local-executor] polling failed: ${safeMachineErrorMessage(error)}\n`);
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
  process.stderr.write(`[local-executor] failed to close MCP session: ${safeMachineErrorMessage(error)}\n`);
});
if (fatalApiError) process.exitCode = 1;
