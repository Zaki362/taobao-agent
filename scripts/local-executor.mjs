import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";

const execFileAsync = promisify(execFile);
const apiBaseUrl = (process.env.SCENECART_API_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const deviceToken = process.env.SCENECART_DEVICE_TOKEN;
const qoderPath = process.env.QODERCLI_PATH || `${os.homedir()}/.local/bin/qodercli`;
const pollMs = Math.max(Number(process.env.EXECUTOR_POLL_MS || 2500), 500);
const qoderTimeoutMs = Math.max(Number(process.env.EXECUTOR_QODER_TIMEOUT_MS || 180000), 30000);
const resultDir = path.join(process.cwd(), ".data", "local-executor", "results");

if (!deviceToken) {
  throw new Error("SCENECART_DEVICE_TOKEN is required. Register a device at /settings/executor first.");
}

let currentJobId = null;
let stopped = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${deviceToken}`,
      "Content-Type": "application/json",
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
  const response = await fetch(`${apiBaseUrl}/api/runtime/health`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status !== "healthy") {
    throw new Error(payload.error || `SceneCart API health check failed with ${response.status}`);
  }
  process.stdout.write(`[local-executor] startup checks passed; runtime=${payload.runtime_store}; backend=${payload.executor_backend}\n`);
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

async function readCachedResult(jobId) {
  try {
    return JSON.parse(await fs.readFile(path.join(resultDir, `${jobId}.json`), "utf-8"));
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

function searchPrompt(job) {
  const payload = job.payload || {};
  return [
    "你是 SceneCart AI 的本地淘宝搜索执行器。",
    "必须使用当前已安装的淘宝 skill 执行真实搜索，不要编造商品。",
    `搜索词：${payload.keyword}`,
    `模块：${payload.module_name}（${payload.module_id}）`,
    `模块预算：${payload.budget ?? "未指定"} 元`,
    "选择最多 3 个有代表性的候选，覆盖稳妥推荐、性价比推荐、升级推荐；不足 3 个时返回真实可用数量。",
    "只返回严格 JSON，不要解释。格式：",
    JSON.stringify({
      summary: "完成真实淘宝搜索",
      candidates: [
        {
          product_id: "string",
          title: "string",
          price: 0,
          source: "淘宝",
          shop_name: "string",
          image_url: "string",
          detail_url: "string",
          shop_badges: ["string"],
          highlights: ["string"],
          risk_notes: ["当前为搜索摘要，请在商品页确认规格"],
          fit_reason: "string",
          recommendation_type: "稳妥推荐",
          module_id: payload.module_id
        }
      ]
    }, null, 2)
  ].join("\n");
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

async function executeJob(job) {
  const prompt = job.job_type === "module_search" ? searchPrompt(job) : cartPrompt(job);
  const { stdout } = await execFileAsync(qoderPath, [
    "-p", prompt,
    "-q",
    "--yolo",
    "--allowed-tools", "Skill,Bash,Read",
    "--max-turns", job.job_type === "module_search" ? "6" : "5",
    "-f", "text"
  ], {
    env: process.env,
    timeout: qoderTimeoutMs,
    maxBuffer: 8 * 1024 * 1024
  });
  return parseJson(stdout);
}

async function heartbeat() {
  try {
    await api("/api/executor/heartbeat", {
      method: "POST",
      body: JSON.stringify({ current_job_id: currentJobId })
    });
  } catch (error) {
    process.stderr.write(`[local-executor] heartbeat failed: ${error.message}\n`);
  }
}

await verifyStartup();
const heartbeatTimer = setInterval(heartbeat, 15000);

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
      currentJobId = job.id;
      process.stdout.write(`[local-executor] claimed ${job.job_type} ${job.id} (attempt ${job.attempts}/${job.max_attempts})\n`);
      let result;
      try {
        const cached = await readCachedResult(job.id);
        result = cached ?? await executeJob(job);
        if (!cached) await cacheResult(job.id, result);
      } catch (error) {
        await reportResult(job.id, { status: "failed", error: error.message }).catch((resolveError) => {
          process.stderr.write(`[local-executor] failed to report ${job.id}: ${resolveError.message}\n`);
        });
        process.stderr.write(`[local-executor] job ${job.id} failed: ${error.message}\n`);
        currentJobId = null;
        continue;
      }

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
      currentJobId = null;
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
  });
}

await loop();
