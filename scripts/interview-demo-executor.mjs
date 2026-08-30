import process from "node:process";
import protocol from "../lib/runtime/executor-protocol.json" with { type: "json" };
import {
  buildInterviewDemoCartResult,
  buildInterviewDemoSearchResult,
  loadInterviewDemoSnapshot
} from "./interview-demo-utils.mjs";

if (process.env.SCENECART_INTERVIEW_DEMO !== "true") {
  throw new Error("拒绝启动：必须显式设置 SCENECART_INTERVIEW_DEMO=true");
}

const apiBaseUrl = new URL(process.env.SCENECART_API_URL || "http://127.0.0.1:3200");
if (!['127.0.0.1', 'localhost'].includes(apiBaseUrl.hostname)) {
  throw new Error("面试演示执行器只允许连接本机场景购服务");
}
const deviceToken = process.env.SCENECART_DEVICE_TOKEN?.trim();
if (!deviceToken) {
  throw new Error("SCENECART_DEVICE_TOKEN is required");
}

const pollMs = Math.max(Number(process.env.EXECUTOR_POLL_MS || 200), 100);
const snapshot = await loadInterviewDemoSnapshot();
let stopped = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function endpoint(pathname) {
  return new URL(pathname, apiBaseUrl).toString();
}

async function api(pathname, options = {}) {
  const response = await fetch(endpoint(pathname), {
    ...options,
    signal: options.signal || AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${deviceToken}`,
      "Content-Type": "application/json",
      "X-SceneCart-Executor-Protocol": protocol.version,
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `${pathname} failed with ${response.status}`);
  }
  return payload;
}

async function resolveJob(job, body) {
  await api(`/api/executor/jobs/${encodeURIComponent(job.id)}/resolve`, {
    method: "POST",
    body: JSON.stringify({ ...body, lease_token: job.lease_token })
  });
}

async function runJob(job) {
  if (job.job_type === "module_search") {
    const result = buildInterviewDemoSearchResult(snapshot, job);
    await resolveJob(job, { status: "completed", result });
    process.stdout.write(
      `[interview-demo-worker] ${job.payload?.module_name || job.payload?.module_id}: ${result.candidates.length} 个非实时候选已回填\n`
    );
    return;
  }

  if (job.job_type === "add_to_cart") {
    const result = buildInterviewDemoCartResult(job.payload?.product_id);
    await resolveJob(job, { status: "completed", result });
    process.stdout.write(
      `[interview-demo-worker] ${result.product_id}: 仅加入产品内演示清单（淘宝加购调用 0 次）\n`
    );
    return;
  }

  if (job.job_type === "product_detail") {
    await resolveJob(job, {
      status: "completed",
      result: {
        detail_evidence: {
          schema: "scenecart.taobao-mcp-product-detail-evidence/v1",
          source: "taobao-mcp",
          status: "unavailable",
          tool: "navigate_to_url+read_page_content",
          tools_used: [],
          source_app: "SceneCartInterviewDemo",
          job_id: job.id,
          search_job_id: job.payload?.search_job_id,
          module_id: job.payload?.module_id,
          workflow_run_id: job.payload?.workflow_run_id,
          product_id: job.payload?.product_id,
          detail_url: job.payload?.detail_url,
          captured_at: new Date().toISOString(),
          unavailable_reason: "隔离演示不访问淘宝详情页"
        }
      }
    });
    return;
  }

  await resolveJob(job, {
    status: "failed",
    retryable: false,
    error: `面试演示执行器不支持任务类型：${job.job_type}`
  });
}

async function main() {
  const heartbeat = await api("/api/executor/heartbeat", {
    method: "POST",
    body: "{}"
  });
  const capabilities = Array.isArray(heartbeat.device?.capabilities)
    ? heartbeat.device.capabilities
    : [];
  if (!capabilities.includes("module_search") || !capabilities.includes("add_to_cart")) {
    throw new Error("面试演示设备必须同时具备 module_search 与 add_to_cart 能力");
  }

  process.stdout.write(
    `[interview-demo-worker] 已启动；数据=${snapshot.captured_at} 历史快照；实时淘宝搜索/加购/下单调用均为 0\n`
  );

  while (!stopped) {
    try {
      const { job } = await api("/api/executor/jobs/claim", {
        method: "POST",
        body: "{}"
      });
      if (!job) {
        await sleep(pollMs);
        continue;
      }
      await runJob(job);
    } catch (error) {
      if (stopped) return;
      process.stderr.write(
        `[interview-demo-worker] ${error instanceof Error ? error.message : String(error)}\n`
      );
      await sleep(Math.max(pollMs, 500));
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopped = true;
  });
}

await main();
