import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import nextEnv from "@next/env";
import protocol from "../lib/runtime/executor-protocol.json" with { type: "json" };
import { ExecutorLeaseGuard } from "./executor-lease-guard.mjs";
import {
  buildSearchEvidencePrompt,
  isQoderCreditError,
  isRepeatedToolCallError,
  isTaobaoLoginError,
  normalizeTaobaoSearchEvidence,
  qoderPrintArgs,
  searchEvidencePath
} from "./local-executor-utils.mjs";

nextEnv.loadEnvConfig(process.cwd());

const execFileAsync = promisify(execFile);
const apiBaseUrl = (process.env.SCENECART_API_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const deviceToken = process.env.SCENECART_DEVICE_TOKEN;
const qoderPath = process.env.QODERCLI_PATH || `${os.homedir()}/.local/bin/qodercli`;
const pollMs = Math.max(Number(process.env.EXECUTOR_POLL_MS || 2500), 500);
const qoderTimeoutMs = Math.max(Number(process.env.EXECUTOR_QODER_TIMEOUT_MS || 180000), 30000);
const apiTimeoutMs = Math.max(Number(process.env.EXECUTOR_API_TIMEOUT_MS || 20000), 5000);
const leaseFailureLimit = Math.max(Number(process.env.EXECUTOR_LEASE_FAILURE_LIMIT || 3), 1);
const resultDir = path.join(process.cwd(), ".data", "local-executor", "results");
const evidenceDir = path.join(process.cwd(), ".data", "local-executor", "evidence");
const executorProtocolVersion = protocol.version;

if (!deviceToken) {
  throw new Error("SCENECART_DEVICE_TOKEN is required. Register a device at /settings/executor first.");
}

let heartbeatInFlight = false;
let stopped = false;
const leaseGuard = new ExecutorLeaseGuard({
  failureLimit: leaseFailureLimit,
  onLeaseLost: ({ jobId, reason }) => {
    process.stderr.write(`[local-executor] lease lost for ${jobId}: ${reason}; stopping local execution\n`);
  }
});

class ExecutorJobError extends Error {
  constructor(message, retryable = true) {
    super(message);
    this.name = "ExecutorJobError";
    this.retryable = retryable;
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
  await fs.access(qoderPath, fsConstants.X_OK).catch(() => {
    throw new Error(`Qoder CLI is not executable at ${qoderPath}. Set QODERCLI_PATH to the installed binary.`);
  });
  try {
    const { stdout, stderr } = await execFileAsync(
      qoderPath,
      qoderPrintArgs("只返回严格 JSON：{\"ok\":true}", ["Read"]),
      {
      env: process.env,
      timeout: 20_000,
      maxBuffer: 1024 * 1024
      }
    );
    if (!stdout.trim()) {
      throw qoderJobError(undefined, stdout, stderr);
    }
  } catch (error) {
    if (error instanceof ExecutorJobError) throw error;
    throw qoderJobError(error);
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
  if (heartbeatPayload.protocol_version !== executorProtocolVersion) {
    throw new Error("服务端未确认当前执行器协议，请更新项目代码后重启。");
  }
  process.stdout.write(
    `[local-executor] startup checks passed; qoder=session-ready; runtime=${payload.runtime_store}; backend=${payload.effective_executor_backend}; capabilities=${capabilities.join(",")}\n`
  );
}

function parseJson(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Qoder CLI returned empty output");
  try {
    const parsed = JSON.parse(trimmed);
    const content = parsed?.result || parsed?.content || parsed?.message?.content;
    if (typeof content === "string") return parseJson(content);
    return parsed;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("Qoder CLI output was not valid JSON");
  }
}

function processOutput(error, stdout = "", stderr = "") {
  const candidate = error && typeof error === "object" ? error : {};
  return [stdout, stderr, candidate.stdout, candidate.stderr, candidate.message]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n")
    .trim();
}

function qoderJobError(error, stdout = "", stderr = "") {
  const output = processOutput(error, stdout, stderr);
  if (isQoderCreditError(output)) {
    return new ExecutorJobError(
      "Qoder CLI 账户额度已用尽，当前无法调用淘宝 skill。请等待额度恢复或升级 Qoder 订阅后重试。",
      false
    );
  }
  if (/upgrade required|update available/i.test(output)) {
    return new ExecutorJobError(
      "Qoder CLI 版本已过期，请先运行 qodercli update，确认 qodercli --version 正常后再启动执行器。",
      false
    );
  }
  if (/not logged in|please run \/login|authentication required|unauthorized/i.test(output)) {
    return new ExecutorJobError(
      "Qoder CLI 未登录，请在终端运行 qodercli，输入 /login 完成登录后再启动执行器。",
      false
    );
  }
  if (isTaobaoLoginError(output)) {
    return new ExecutorJobError(
      "淘宝桌面版当前未登录。请在淘宝桌面版完成登录并保持主界面打开，然后重新执行当前搜索。",
      false
    );
  }
  if (isRepeatedToolCallError(output)) {
    return new ExecutorJobError(
      "Qoder 拒绝了重复工具调用。当前任务已停止，避免继续产生不确定结果。",
      false
    );
  }
  if (!output) {
    return new ExecutorJobError("Qoder CLI 未返回内容。", true);
  }
  return new ExecutorJobError(output.slice(0, 1000), true);
}

async function readCachedResult(job) {
  try {
    const result = JSON.parse(await fs.readFile(path.join(resultDir, `${job.id}.json`), "utf-8"));
    if (job.job_type === "module_search" && result?.evidence?.source !== "taobao-native") {
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
        body: JSON.stringify(payload)
      });
    } catch (error) {
      lastError = error;
      await sleep(attempt * 750);
    }
  }
  throw lastError;
}

function cartPrompt(job) {
  const payload = job.payload || {};
  return [
    "你是 SceneCart AI 的淘宝加购执行器。用户已经在产品页面显式确认本次加购。",
    "必须使用当前已安装的淘宝 skill，并且只通过 itemId 获取 SKU 后加入购物车。",
    "禁止打开商品详情页，禁止 navigate_to_url，禁止执行任何订单提交或付款动作。",
    `商品 ID：${payload.product_id}`,
    `商品标题：${payload.product_title}`,
    "成功或失败都只返回严格 JSON：",
    JSON.stringify({ success: true, message: "已加入淘宝购物车", product_id: payload.product_id }, null, 2)
  ].join("\n");
}

async function executeJob(job, signal) {
  const payload = job.payload || {};
  const evidencePath = job.job_type === "module_search"
    ? searchEvidencePath(evidenceDir, job.id)
    : null;
  if (evidencePath) {
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.rm(evidencePath, { force: true });
  }
  const startedAt = Date.now();
  const prompt = job.job_type === "module_search"
    ? buildSearchEvidencePrompt({
        keyword: payload.keyword,
        moduleName: payload.module_name,
        moduleId: payload.module_id,
        evidencePath
      })
    : cartPrompt(job);
  let stdout = "";
  let stderr = "";
  let commandError;
  try {
    const output = await execFileAsync(
      qoderPath,
      qoderPrintArgs(prompt, job.job_type === "module_search" ? ["Bash"] : ["Skill", "Bash", "Read"]),
      {
      env: process.env,
      timeout: qoderTimeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      signal
      }
    );
    stdout = output.stdout ?? "";
    stderr = output.stderr ?? "";
  } catch (error) {
    commandError = error;
  }

  if (job.job_type === "module_search" && evidencePath) {
    try {
      const stat = await fs.stat(evidencePath);
      if (stat.mtimeMs + 1000 < startedAt) {
        throw new Error("淘宝搜索证据不是当前任务生成的，已拒绝复用旧结果。");
      }
      const raw = JSON.parse(await fs.readFile(evidencePath, "utf-8"));
      const result = normalizeTaobaoSearchEvidence(raw, {
        keyword: String(payload.keyword ?? "").trim(),
        moduleId: String(payload.module_id ?? "").trim()
      });
      process.stdout.write(
        `[local-executor] verified ${result.candidates.length} Taobao candidates from evidence for ${job.id}\n`
      );
      return result;
    } catch (evidenceError) {
      if (!commandError) {
        const message = evidenceError?.code === "ENOENT"
          ? "Qoder 未生成淘宝搜索证据文件，已拒绝使用模型输出作为商品结果。"
          : evidenceError.message;
        throw new ExecutorJobError(message, false);
      }
    }
    throw qoderJobError(commandError, stdout, stderr);
  }

  if (commandError) throw qoderJobError(commandError, stdout, stderr);
  if (!stdout.trim()) {
    throw qoderJobError(undefined, stdout, stderr);
  }
  try {
    return parseJson(stdout);
  } catch (error) {
    throw qoderJobError(error, stdout, stderr);
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
