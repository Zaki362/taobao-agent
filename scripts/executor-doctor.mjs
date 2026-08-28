import process from "node:process";
import nextEnv from "@next/env";
import protocol from "../lib/runtime/executor-protocol.json" with { type: "json" };
import { discoverExecutorApiUrl } from "./executor-config-utils.mjs";
import {
  executorDoctorExitCode,
  MCP_READINESS_EXIT_CODE
} from "./local-executor-readiness.mjs";
import { TaobaoMcpClient } from "./taobao-mcp-client.mjs";
import { TaobaoNativeCliClient } from "./taobao-native-cli-client.mjs";
import {
  safeMachineErrorMessage,
  vercelProtectedFetch
} from "./vercel-protection-bypass.mjs";

nextEnv.loadEnvConfig(process.cwd());

const configuredApiBaseUrl = (process.env.SCENECART_API_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const apiBaseUrl = await discoverExecutorApiUrl(configuredApiBaseUrl);
const taobaoMcpUrl = process.env.TAOBAO_NATIVE_MCP_URL || "http://127.0.0.1:3654/mcp";
const taobaoSourceApp = process.env.TAOBAO_SOURCE_APP || "SceneCartAI";
const deviceToken = process.env.SCENECART_DEVICE_TOKEN;
const checks = [];
const compactOutput = process.argv.includes("--compact");
const executorProtocolVersion = protocol.version;
let taobaoToolNames = new Set();
let taobaoSearchReady = false;
let taobaoSearchDriver = "http_mcp";
let heartbeatAccepted = false;

async function check(name, task) {
  try {
    const detail = await task();
    checks.push({ name, status: "pass", detail });
  } catch (error) {
    checks.push({ name, status: "fail", detail: safeMachineErrorMessage(error) });
  }
}

await check("taobao_mcp", async () => {
  const client = new TaobaoMcpClient({
    endpoint: taobaoMcpUrl,
    sourceApp: taobaoSourceApp,
    timeoutMs: 10_000
  });
  try {
    try {
      const tools = await client.listTools();
      taobaoToolNames = new Set(tools.map((tool) => tool?.name));
      const missingSearchTools = ["search_products", "get_current_tab"].filter(
        (name) => !taobaoToolNames.has(name)
      );
      if (missingSearchTools.length > 0) {
        throw new Error(`淘宝桌面版 MCP 缺少搜索/登录恢复工具：${missingSearchTools.join("、")}`);
      }
      taobaoSearchReady = true;
      taobaoSearchDriver = "http_mcp";
      return `${taobaoMcpUrl} · search_products 已就绪 · source=${taobaoSourceApp}`;
    } catch (httpError) {
      const cliClient = new TaobaoNativeCliClient({
        sourceApp: taobaoSourceApp,
        timeoutMs: 10_000
      });
      try {
        await cliClient.probeSearchReadiness();
      } catch (cliError) {
        throw new Error(
          `HTTP MCP: ${httpError instanceof Error ? httpError.message : String(httpError)}；官方 CLI: ${cliError instanceof Error ? cliError.message : String(cliError)}`
        );
      }
      taobaoSearchReady = true;
      taobaoSearchDriver = "native_cli";
      taobaoToolNames = new Set(["search_products", "list_available_pages"]);
      return `官方 CLI 搜索执行层已就绪 · HTTP MCP 暂不可用 · source=${taobaoSourceApp}`;
    }
  } finally {
    await client.close().catch(() => undefined);
  }
});

await check("scenecart_api", async () => {
  const response = await vercelProtectedFetch(`${apiBaseUrl}/api/runtime/health`, {
    signal: AbortSignal.timeout(8_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status !== "healthy") {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  if (payload.executor_protocol_version !== executorProtocolVersion) {
    throw new Error(`执行器协议不兼容：本地=${executorProtocolVersion}，服务端=${payload.executor_protocol_version ?? "未知"}`);
  }
  return `${apiBaseUrl} · runtime=${payload.runtime_store} · backend=${payload.effective_executor_backend} · protocol=${executorProtocolVersion}`;
});

await check("device_token", async () => {
  if (!deviceToken) {
    throw new Error("SCENECART_DEVICE_TOKEN 未配置；请先在 /settings/executor 注册设备");
  }
  const response = await vercelProtectedFetch(`${apiBaseUrl}/api/executor/heartbeat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deviceToken}`,
      "Content-Type": "application/json",
      "X-SceneCart-Executor-Protocol": executorProtocolVersion
    },
    body: JSON.stringify({
      executor_state: taobaoSearchReady ? "online" : "mcp_unavailable"
    }),
    signal: AbortSignal.timeout(8_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  if (payload.protocol_version !== executorProtocolVersion) {
    throw new Error("服务端未确认当前执行器协议版本");
  }
  heartbeatAccepted = true;
  const capabilities = Array.isArray(payload.device?.capabilities) ? payload.device.capabilities : [];
  if (!capabilities.includes("module_search")) {
    throw new Error("设备令牌有效，但缺少 module_search 能力；请在设置页重新注册设备");
  }
  const labels = capabilities.map((capability) =>
    capability === "module_search" ? "商品搜索" : capability === "add_to_cart" ? "真实加购" : capability
  );
  if (taobaoSearchReady && capabilities.includes("add_to_cart")) {
    const missingCartTools = ["get_product_skus", "add_to_cart"].filter(
      (name) => !taobaoToolNames.has(name)
    );
    if (missingCartTools.length > 0) {
      labels.push(`真实加购暂不可用（缺少 ${missingCartTools.join("、")}）`);
    }
  }
  const authenticationState = payload.executor_state === "authentication_required"
    ? "；设备仍保持登录暂停，Worker 会在淘宝登录恢复后自动解除"
    : "";
  const mcpState = !taobaoSearchReady && payload.executor_state !== "authentication_required"
    ? "；淘宝 MCP 尚未就绪，设备已安全标记为重连中"
    : "";
  return `设备令牌有效，服务端已收到心跳${authenticationState}${mcpState}；授权能力：${labels.join("、")}`;
});

for (const item of checks) {
  if (compactOutput && item.status === "pass") continue;
  process.stdout.write(`${item.status === "pass" ? "PASS" : "FAIL"}  ${item.name}: ${item.detail}\n`);
}
if (!compactOutput) {
  process.stdout.write(
    taobaoSearchDriver === "native_cli"
      ? "INFO  taobao_driver: 商品搜索将使用淘宝桌面版官方 CLI 安全兜底；不会经过 Qoder；详情读取与真实加购仍等待 HTTP MCP\n"
      : "INFO  taobao_driver: 商品搜索与真实加购均直连淘宝桌面版官方 HTTP MCP，不再消耗 Qoder Credits\n"
  );
  process.stdout.write("INFO  taobao_skill: Doctor 不主动搜索或打开详情页；第一条已确认任务会验证真实登录态\n");
}

const doctorExitCode = executorDoctorExitCode(checks);
if (doctorExitCode !== 0) {
  process.exitCode = doctorExitCode;
  if (!compactOutput && doctorExitCode === MCP_READINESS_EXIT_CODE) {
    process.stdout.write(
      "WAIT  taobao_mcp: 这是可恢复的未就绪状态；云端启动器会等待淘宝桌面版恢复\n"
    );
  }
}

// Doctor is a one-shot diagnostic, not a task consumer. Do not leave a fresh
// online heartbeat behind after it exits, otherwise the website could briefly
// advertise real search while no Worker is running.
if (heartbeatAccepted && deviceToken) {
  await vercelProtectedFetch(`${apiBaseUrl}/api/executor/heartbeat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deviceToken}`,
      "Content-Type": "application/json",
      "X-SceneCart-Executor-Protocol": executorProtocolVersion
    },
    body: JSON.stringify({ executor_state: "offline" }),
    signal: AbortSignal.timeout(8_000)
  }).catch(() => undefined);
}
