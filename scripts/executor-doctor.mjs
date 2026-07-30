import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const apiBaseUrl = (process.env.SCENECART_API_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const qoderPath = process.env.QODERCLI_PATH || `${os.homedir()}/.local/bin/qodercli`;
const deviceToken = process.env.SCENECART_DEVICE_TOKEN;
const checks = [];

async function check(name, task) {
  try {
    const detail = await task();
    checks.push({ name, status: "pass", detail });
  } catch (error) {
    checks.push({ name, status: "fail", detail: error instanceof Error ? error.message : String(error) });
  }
}

await check("qoder_cli", async () => {
  await fs.access(qoderPath, fsConstants.X_OK);
  const { stdout, stderr } = await execFileAsync(qoderPath, ["--version"], {
    timeout: 8_000,
    maxBuffer: 1024 * 1024
  });
  return `${qoderPath} · ${(stdout || stderr || "version available").trim().slice(0, 160)}`;
});

await check("scenecart_api", async () => {
  const response = await fetch(`${apiBaseUrl}/api/runtime/health`, {
    signal: AbortSignal.timeout(8_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status !== "healthy") {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return `${apiBaseUrl} · runtime=${payload.runtime_store} · backend=${payload.executor_backend}`;
});

await check("device_token", async () => {
  if (!deviceToken) {
    throw new Error("SCENECART_DEVICE_TOKEN 未配置；请先在 /settings/executor 注册设备");
  }
  const response = await fetch(`${apiBaseUrl}/api/executor/heartbeat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deviceToken}`,
      "Content-Type": "application/json"
    },
    body: "{}",
    signal: AbortSignal.timeout(8_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return "设备令牌有效，服务端已收到心跳";
});

for (const item of checks) {
  process.stdout.write(`${item.status === "pass" ? "PASS" : "FAIL"}  ${item.name}: ${item.detail}\n`);
}
process.stdout.write("INFO  taobao_skill: 不在 Doctor 中主动调用；第一条已确认搜索任务会进行真实能力验证\n");

if (checks.some((item) => item.status === "fail")) {
  process.exitCode = 1;
}
