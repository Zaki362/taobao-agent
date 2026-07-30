import fs from "node:fs/promises";
import path from "node:path";

const HOSTED_API_BASE_URL = process.env.HOSTED_API_BASE_URL || "http://127.0.0.1:3000";
const OUTPUT_DIR = path.join(process.cwd(), ".data", "hosted-worker");
const STATUS_FILE = path.join(OUTPUT_DIR, "worker-status.json");
const MAX_WORKER_STATUS_TEXT = 220;

function summarizeWorkerStatusText(value, maxLength = MAX_WORKER_STATUS_TEXT) {
  if (typeof value !== "string") {
    return null;
  }

  const text = value
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[redacted-api-key]")
    .replace(/https?:\/\/[^\s"'<>]+/g, (match) => {
      try {
        const url = new URL(match);
        return `${url.origin}${url.pathname}${url.search ? "?..." : ""}`;
      } catch {
        return "[url]";
      }
    })
    .replace(/\/Users\/[^\s"'，。；;:]+/g, "[local-path]")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return null;
  }

  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

async function ensureOutputDir() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
}

async function readWorkerStatus() {
  try {
    const raw = await fs.readFile(STATUS_FILE, "utf-8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function writeWorkerStatus(patch) {
  await ensureOutputDir();
  const current = await readWorkerStatus();
  const next = {
    pid: process.pid,
    api_base_url: HOSTED_API_BASE_URL,
    updated_at: new Date().toISOString(),
    ...current,
    ...patch
  };
  await fs.writeFile(STATUS_FILE, JSON.stringify(next, null, 2), "utf-8");
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(
      payload && typeof payload.error === "string"
        ? payload.error
        : `${response.status} ${response.statusText}`
    );
  }

  return payload;
}

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const flags = {};

  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index];
    if (!part.startsWith("--")) {
      continue;
    }
    const key = part.slice(2);
    const next = rest[index + 1];
    flags[key] = next && !next.startsWith("--") ? next : "true";
    if (next && !next.startsWith("--")) {
      index += 1;
    }
  }

  return { command, flags };
}

async function getNextTask(sessionId) {
  const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : "";
  return fetchJson(`${HOSTED_API_BASE_URL}/api/hosted/tasks/next${query}`);
}

async function markRunning(sessionId, taskId) {
  return fetchJson(`${HOSTED_API_BASE_URL}/api/hosted/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      session_id: sessionId,
      task_id: taskId,
      status: "running"
    })
  });
}

async function resolveTask(payload) {
  return fetchJson(`${HOSTED_API_BASE_URL}/api/hosted/tasks/resolve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

async function writeTaskFiles(task, instruction) {
  await ensureOutputDir();
  const base = path.join(OUTPUT_DIR, task.task_id);
  const instructionPath = `${base}.instruction.md`;
  const payloadPath = `${base}.task.json`;
  const resolveTemplatePath = `${base}.resolve.json`;

  const resolveTemplate =
    task.task_type === "module_search"
      ? {
          session_id: task.session_id,
          task_id: task.task_id,
          status: "completed",
          result_summary: "已由 Codex 宿主完成淘宝搜索并回填候选商品",
          candidates: []
        }
      : {
          session_id: task.session_id,
          task_id: task.task_id,
          status: "completed",
          result_summary: "已由 Codex 宿主完成加购"
        };

  await fs.writeFile(instructionPath, instruction ?? "", "utf-8");
  await fs.writeFile(payloadPath, JSON.stringify(task, null, 2), "utf-8");
  await fs.writeFile(resolveTemplatePath, JSON.stringify(resolveTemplate, null, 2), "utf-8");

  return { instructionPath, payloadPath, resolveTemplatePath };
}

function printTaskSummary(task, files) {
  console.log(`\n[Codex Hosted Worker] 已获取任务: ${task.task_id}`);
  console.log(`类型: ${task.task_type}`);
  console.log(`标题: ${task.title}`);
  console.log(`会话: ${task.session_id}`);
  console.log(`状态: ${task.status}`);
  console.log(`说明文件: ${files.instructionPath}`);
  console.log(`任务文件: ${files.payloadPath}`);
  console.log(`回填模板: ${files.resolveTemplatePath}\n`);
}

function printInstructionHint(instruction) {
  if (!instruction) {
    return;
  }
  console.log("[Codex Hosted Worker] 已生成宿主执行说明，可将其交给 Codex 宿主完成任务。");
}

async function packageTask(task, instruction) {
  const files = await writeTaskFiles(task, instruction);
  printTaskSummary(task, files);
  printInstructionHint(instruction);
  await writeWorkerStatus({
    mode: "codex_proxy",
    state: "awaiting_codex_execution",
    started_at: new Date().toISOString(),
    last_task_id: task.task_id,
    last_task_type: task.task_type,
    last_result: null,
    last_error: null
  });
}

async function nextCommand(flags) {
  const data = await getNextTask(flags.session);
  if (!data.task) {
    console.log("当前没有待执行的 Codex 宿主任务。");
    await writeWorkerStatus({
      mode: "codex_proxy",
      state: "idle",
      last_error: null
    });
    return;
  }

  await markRunning(data.task.session_id, data.task.task_id);
  await packageTask(
    {
      ...data.task,
      status: "running"
    },
    data.instruction
  );
}

async function resolveCommand(flags) {
  const file = flags.file;
  if (!file) {
    throw new Error("请使用 --file 指定回填 JSON 文件。");
  }

  const raw = await fs.readFile(path.resolve(file), "utf-8");
  const payload = JSON.parse(raw);
  const response = await resolveTask(payload);

  await writeWorkerStatus({
    mode: "codex_proxy",
    state: "idle",
    last_task_id: payload.task_id ?? null,
    last_result: summarizeWorkerStatusText(payload.result_summary),
    last_error: summarizeWorkerStatusText(payload.error_message)
  });

  console.log("回填成功。");
  console.log(JSON.stringify(response, null, 2));
}

async function watchCommand(flags) {
  const interval = Number(flags.interval || 5000);
  const seen = new Set();

  console.log(`[Codex Hosted Worker] 监听待执行任务中，轮询间隔 ${interval}ms`);
  await writeWorkerStatus({
    mode: "codex_proxy",
    state: "idle",
    started_at: new Date().toISOString(),
    interval_ms: interval,
    last_error: null
  });

  for (;;) {
    try {
      const data = await getNextTask(flags.session);
      if (data.task && !seen.has(data.task.task_id)) {
        seen.add(data.task.task_id);
        await markRunning(data.task.session_id, data.task.task_id);
        await packageTask(
          {
            ...data.task,
            status: "running"
          },
          data.instruction
        );
      } else if (!data.task) {
        await writeWorkerStatus({
          mode: "codex_proxy",
          state: "idle",
          last_error: null
        });
      }
    } catch (error) {
      await writeWorkerStatus({
        mode: "codex_proxy",
        state: "idle",
        last_error: summarizeWorkerStatusText(error instanceof Error ? error.message : String(error))
      });
      console.error(`[Codex Hosted Worker] ${error instanceof Error ? error.message : String(error)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function printHelp() {
  console.log(`
Codex Hosted Worker

用法:
  npm run worker:codex -- next [--session <session_id>]
  npm run worker:codex -- watch [--session <session_id>] [--interval 5000]
  npm run worker:codex -- resolve --file .data/hosted-worker/<task>.resolve.json

环境变量:
  HOSTED_API_BASE_URL   默认 http://127.0.0.1:3000

说明:
  该 worker 不直接执行淘宝工具。
  它负责：
  1. 拉取待执行任务
  2. 标记为 running
  3. 生成宿主执行说明、任务文件、回填模板
  4. 等待 Codex 宿主完成淘宝任务后，通过 resolve 回填结果
`);
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command === "next") {
    await nextCommand(flags);
    return;
  }

  if (command === "watch") {
    await watchCommand(flags);
    return;
  }

  if (command === "resolve") {
    await resolveCommand(flags);
    return;
  }

  printHelp();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
