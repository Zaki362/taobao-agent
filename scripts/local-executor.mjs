import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import nextEnv from "@next/env";
import protocol from "../lib/runtime/executor-protocol.json" with { type: "json" };
import { ExecutorLeaseGuard } from "./executor-lease-guard.mjs";
import { TaobaoMcpClient } from "./taobao-mcp-client.mjs";
import {
  buildTaobaoMcpSearchEvidence,
  cacheResultForAcknowledgement,
  classifyTaobaoAuthentication,
  createPendingAuthenticationFailure,
  executorFailureDisposition,
  isTaobaoLoginError,
  normalizeTaobaoCartResult,
  normalizeTaobaoSearchEvidence,
  PendingAuthenticationFailureCoordinator,
  PendingAuthenticationFailureStore,
  prepareTaobaoCartAction
} from "./local-executor-utils.mjs";

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
const taobaoSourceApp = process.env.TAOBAO_SOURCE_APP || "SceneCartAI";
const apiTimeoutMs = Math.max(Number(process.env.EXECUTOR_API_TIMEOUT_MS || 20000), 5000);
const resolveTimeoutMs = Math.max(Number(process.env.EXECUTOR_RESOLVE_TIMEOUT_MS || 60000), apiTimeoutMs);
const leaseFailureLimit = Math.max(Number(process.env.EXECUTOR_LEASE_FAILURE_LIMIT || 3), 1);
const resultDir = path.join(process.cwd(), ".data", "local-executor", "results");
const pendingAuthFailurePath = path.join(
  process.cwd(),
  ".data",
  "local-executor",
  "pending-auth-failure.json"
);
const executorProtocolVersion = protocol.version;
if (!deviceToken) {
  throw new Error("SCENECART_DEVICE_TOKEN is required. Register a device at /settings/executor first.");
}

let heartbeatInFlight = null;
let stopped = false;
let authenticationPaused = false;
let lastAuthenticationProbeAt = 0;
let lastTaobaoSearchFinishedAt = 0;
const leaseGuard = new ExecutorLeaseGuard({
  failureLimit: leaseFailureLimit,
  onLeaseLost: ({ jobId, reason }) => {
    process.stderr.write(`[local-executor] lease lost for ${jobId}: ${reason}; stopping local execution\n`);
  }
});
const pendingAuthFailureStore = new PendingAuthenticationFailureStore(pendingAuthFailurePath);
const pendingAuthFailureCoordinator = new PendingAuthenticationFailureCoordinator(pendingAuthFailureStore);

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
    // An omitted state brings a normal offline device online, but preserves a
    // persisted authentication pause after a Worker restart.
    body: authenticationPaused
      ? JSON.stringify({ executor_state: "authentication_required" })
      : "{}"
  });
  const capabilities = Array.isArray(heartbeatPayload.device?.capabilities)
    ? heartbeatPayload.device.capabilities
    : [];
  if (!capabilities.includes("module_search")) {
    throw new Error("设备令牌没有 module_search 能力，请在执行器设置页重新注册搜索设备。");
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
  // A restored durable callback must pause the server before any Taobao MCP
  // startup traffic. If Taobao itself is unavailable, the Job still cannot replay.
  const tools = await taobaoClient.listTools();
  const toolNames = new Set(tools.map((tool) => tool?.name));
  if (!toolNames.has("search_products")) {
    throw new Error("淘宝桌面版 MCP 未暴露 search_products 工具");
  }
  if (!toolNames.has("get_current_tab")) {
    throw new Error("淘宝桌面版 MCP 未暴露 get_current_tab，无法安全验证登录恢复");
  }
  if (capabilities.includes("add_to_cart")) {
    const missingCartTools = ["get_product_skus", "add_to_cart"].filter((name) => !toolNames.has(name));
    if (missingCartTools.length > 0) {
      throw new Error(`设备声明了 add_to_cart 能力，但淘宝桌面版 MCP 缺少：${missingCartTools.join("、")}。`);
    }
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
      `[local-executor] authentication failure callback for ${pending.job_id} remains pending: ${outcome.error || "server did not confirm failed"}\n`
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

async function probeTaobaoAuthentication() {
  try {
    // This probe is deliberately restricted to the authentication-paused state.
    // In that state Taobao has already opened its login page, so reading the
    // current tab cannot consume or duplicate a user-approved shopping action.
    const raw = await taobaoClient.callTool(
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
      // get_current_tab is not a passive health check in Taobao Desktop: when its
      // internal login state is stale it navigates the app to the login page.
      // Keep each user-approved search to one stateful shopping tool call.
      raw = await taobaoClient.callTool("search_products", {
        keyword,
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
        rawResultCount: result.evidence.raw_result_count
      });
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
  const executorState = options.executorState ?? (authenticationPaused ? "authentication_required" : "online");
  const requestBody = {
    current_job_id: jobId,
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
      if (jobId) leaseGuard.acceptHeartbeat(jobId, payload.lease_renewed === true);
      return payload;
    } catch (error) {
      process.stderr.write(`[local-executor] heartbeat failed: ${error.message}\n`);
      if (jobId) leaseGuard.rejectHeartbeat(jobId);
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
      `[local-executor] authentication recovery probe failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    await heartbeat({ executorState: "authentication_required", force: true });
    return false;
  }
  if (state !== "authenticated") {
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
  lastTaobaoSearchFinishedAt = 0;
  process.stdout.write(
    "[local-executor] Taobao authentication recovered; job claiming has resumed and the failed action remains paused until user confirmation\n"
  );
  return true;
}

try {
  const pendingAuthenticationFailure = await pendingAuthFailureCoordinator.restore();
  if (pendingAuthenticationFailure) {
    authenticationPaused = true;
    process.stderr.write(
      `[local-executor] restored pending authentication failure callback for ${pendingAuthenticationFailure.job_id}\n`
    );
  }
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
      await recoverTaobaoAuthentication();
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
      let resultCached = false;
      let nonReplayableCacheFailure = "";
      try {
        await heartbeat();
        if (leaseGuard.lossReason) throw new Error(leaseGuard.lossReason);
        const cached = await readCachedResult(job);
        resultCached = Boolean(cached);
        result = cached ?? await executeJob(job, jobSignal);
        if (!cached) {
          const cacheOutcome = await cacheResultForAcknowledgement(
            job,
            result,
            () => cacheResult(job.id, result)
          );
          if (!cacheOutcome.cached) {
            nonReplayableCacheFailure = cacheOutcome.error || "unknown cache failure";
            // The cart mutation already succeeded. Keep the in-memory result and
            // resolve it directly; max_attempts=1 makes any lost acknowledgement
            // terminal instead of ever executing add_to_cart again.
            process.stderr.write(
              `[local-executor] add-to-cart result cache failed for ${job.id}; resolving the successful in-memory result without replay: ${cacheOutcome.error}\n`
            );
          } else {
            resultCached = true;
          }
        }
      } catch (error) {
        const authenticationRequired = error instanceof ExecutorJobError && error.code === "auth_required";
        let authenticationDurabilityEstablished = !authenticationRequired;
        const failureDisposition = executorFailureDisposition({
          authenticationRequired,
          leaseLost: Boolean(leaseGuard.lossReason)
        });
        if (failureDisposition === "abandon_lost_lease") {
          process.stderr.write(
            `[local-executor] abandoned ${job.id} without callback because its lease is no longer owned: ${leaseGuard.lossReason}\n`
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
                `[local-executor] authentication callback ledger write failed; attempting the durable server hold while the lease remains attached: ${persistence.error}\n`
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
            retryable: error instanceof ExecutorJobError ? error.retryable : true
          }).catch((resolveError) => {
            process.stderr.write(`[local-executor] failed to report ${job.id}: ${resolveError.message}\n`);
          });
        }
        process.stderr.write(`[local-executor] job ${job.id} failed: ${error.message}\n`);
        if (authenticationRequired) {
          process.stderr.write(
            "[local-executor] authentication circuit breaker opened; no jobs will be claimed until Taobao login is verified locally\n"
          );
        }
        continue;
      }

      // From this point the local operation is immutable and cached. Result
      // acknowledgement no longer needs to keep the execution lease alive.
      leaseGuard.clear(job.id);
      if (result?.success === false) {
        const resultError = result.code
          ? `[${result.code}] ${result.message || "淘宝工具返回失败"}`
          : result.message || "淘宝工具返回失败";
        await reportResult(job.id, {
          status: "failed",
          error: resultError,
          retryable: result.retryable !== false
        }).catch((error) => {
          process.stderr.write(`[local-executor] failed to report ${job.id}: ${error.message}\n`);
        });
        process.stderr.write(`[local-executor] job ${job.id} returned a failed result\n`);
      } else {
        try {
          await reportResult(job.id, { status: "completed", result });
          process.stdout.write(`[local-executor] completed ${job.id}\n`);
        } catch (error) {
          if (job.job_type === "add_to_cart" && nonReplayableCacheFailure) {
            process.stderr.write(
              `[local-executor] add-to-cart may already have succeeded for ${job.id}, but neither local cache nor server acknowledgement is available; automatic replay is forbidden and the user must check Taobao cart manually: ${error.message}\n`
            );
          } else {
            process.stderr.write(
              `[local-executor] result for ${job.id} ${resultCached ? "is cached" : "remains in memory"}; server acknowledgement failed: ${error.message}\n`
            );
          }
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
