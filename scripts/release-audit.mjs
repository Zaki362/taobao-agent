import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();

function loadEnvFile(relativePath) {
  const target = path.join(ROOT, relativePath);
  if (!fs.existsSync(target)) return;
  for (const rawLine of fs.readFileSync(target, "utf-8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(".env");
loadEnvFile(".env.local");

function configured(value) {
  return Boolean(value?.trim());
}

function productionOrigins(value) {
  if (!configured(value)) return false;
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .every((origin) => /^https:\/\//i.test(origin) && !/localhost|127\.0\.0\.1/i.test(origin));
}

function check(id, label, pass, detail, remediation) {
  return { id, label, status: pass ? "pass" : "fail", detail, remediation: pass ? undefined : remediation };
}

const checks = [
  check(
    "product_mode",
    "正式产品模式",
    process.env.SCENECART_PRODUCT_MODE === "production",
    process.env.SCENECART_PRODUCT_MODE === "production" ? "已启用 production" : "仍是开发预览模式",
    "设置 SCENECART_PRODUCT_MODE=production"
  ),
  check(
    "demo_cart_fallback",
    "禁止演示加购回退",
    process.env.ALLOW_DEMO_CART_FALLBACK === "false",
    process.env.ALLOW_DEMO_CART_FALLBACK === "false" ? "真实加购失败不会伪装成功" : "演示加购回退未显式关闭",
    "设置 ALLOW_DEMO_CART_FALLBACK=false"
  ),
  check(
    "runtime_store",
    "PostgreSQL 运行时",
    process.env.RUNTIME_STORE === "postgres" && configured(process.env.DATABASE_URL),
    process.env.RUNTIME_STORE === "postgres" && configured(process.env.DATABASE_URL) ? "PostgreSQL 配置已提供" : "未配置正式持久化运行时",
    "设置 RUNTIME_STORE=postgres 和 DATABASE_URL"
  ),
  check(
    "authentication",
    "强制用户认证",
    process.env.AUTH_REQUIRED === "true",
    process.env.AUTH_REQUIRED === "true" ? "用户隔离已启用" : "当前允许匿名访问",
    "设置 AUTH_REQUIRED=true"
  ),
  check(
    "workflow_recovery",
    "服务端工作流恢复",
    (process.env.SCENECART_CRON_SECRET?.trim().length ?? 0) >= 32,
    (process.env.SCENECART_CRON_SECRET?.trim().length ?? 0) >= 32
      ? "恢复扫描密钥已配置"
      : "未配置至少 32 字符的恢复扫描密钥",
    "配置 SCENECART_CRON_SECRET，并启动 worker:recovery 或云端 Cron"
  ),
  check(
    "secure_cookie",
    "安全会话 Cookie",
    process.env.AUTH_COOKIE_SECURE === "true",
    process.env.AUTH_COOKIE_SECURE === "true" ? "Secure Cookie 已启用" : "Secure Cookie 未启用",
    "在 HTTPS 环境设置 AUTH_COOKIE_SECURE=true"
  ),
  check(
    "app_origin",
    "HTTPS 正式域名",
    productionOrigins(process.env.APP_ORIGIN),
    productionOrigins(process.env.APP_ORIGIN) ? "APP_ORIGIN 均为正式 HTTPS 地址" : "APP_ORIGIN 缺失或仍包含本地/非 HTTPS 地址",
    "设置 APP_ORIGIN=https://你的正式域名"
  ),
  check(
    "executor_backend",
    "持久本地执行器",
    process.env.TAOBAO_EXECUTION_BACKEND === "local_executor",
    process.env.TAOBAO_EXECUTION_BACKEND === "local_executor" ? "购物任务通过持久队列执行" : "仍在使用开发兼容执行路径",
    "设置 TAOBAO_EXECUTION_BACKEND=local_executor"
  ),
  check(
    "legacy_hosted_worker",
    "关闭旧宿主执行通道",
    !configured(process.env.HOSTED_WORKER_TOKEN),
    !configured(process.env.HOSTED_WORKER_TOKEN) ? "未配置旧 hosted Worker Token" : "仍配置 HOSTED_WORKER_TOKEN",
    "删除 HOSTED_WORKER_TOKEN，并停止 worker:codex"
  ),
  check(
    "mcp_debug_endpoint",
    "关闭手动 MCP 调试端点",
    process.env.SCENECART_ENABLE_MCP_DEBUG !== "true",
    process.env.SCENECART_ENABLE_MCP_DEBUG !== "true"
      ? "手动 MCP 调试端点未启用"
      : "仍配置 SCENECART_ENABLE_MCP_DEBUG=true",
    "设置 SCENECART_ENABLE_MCP_DEBUG=false"
  ),
  check(
    "deepseek",
    "DeepSeek 模型",
    configured(process.env.DEEPSEEK_API_KEY) && process.env.DEEPSEEK_DISABLED !== "true",
    configured(process.env.DEEPSEEK_API_KEY) && process.env.DEEPSEEK_DISABLED !== "true" ? "模型密钥已配置且未禁用" : "模型未配置或被禁用",
    "配置 DEEPSEEK_API_KEY，并确保 DEEPSEEK_DISABLED=false"
  ),
  check(
    "legacy_mock",
    "旧 Mock 标志",
    process.env.TAOBAO_MCP_MODE !== "mock",
    process.env.TAOBAO_MCP_MODE !== "mock" ? "未启用旧 Mock 配置" : "检测到 TAOBAO_MCP_MODE=mock",
    "删除 TAOBAO_MCP_MODE，执行模式只使用 TAOBAO_EXECUTION_BACKEND"
  )
];

const ready = checks.every((item) => item.status === "pass");
const report = {
  ready_for_release: ready,
  checks,
  generated_at: new Date().toISOString()
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write("SceneCart AI release audit\n\n");
  for (const item of checks) {
    process.stdout.write(`${item.status === "pass" ? "PASS" : "FAIL"}  ${item.label}: ${item.detail}\n`);
    if (item.remediation) process.stdout.write(`      下一步：${item.remediation}\n`);
  }
  process.stdout.write(`\n${ready ? "READY" : "NOT READY"}: ${ready ? "静态发布配置已满足正式要求" : "仍有正式发布配置未完成"}\n`);
}

if (!ready) process.exitCode = 1;
