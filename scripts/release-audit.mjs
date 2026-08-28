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

function normalizeHttpsOrigin(value) {
  if (!configured(value)) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function formalOrigins(value) {
  return (value ?? "")
    .split(",")
    .map((origin) => normalizeHttpsOrigin(origin))
    .filter(Boolean);
}

const publicDemoOrigin = normalizeHttpsOrigin(
  process.env.NEXT_PUBLIC_SCENECART_PUBLIC_DEMO_URL ?? "https://scenecart-public-demo.vercel.app"
);
const demoOriginSeparated = Boolean(publicDemoOrigin)
  && !formalOrigins(process.env.APP_ORIGIN).includes(publicDemoOrigin);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIVE_AUDIT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

function recentIsoTimestamp(value, maxAgeMs) {
  if (!configured(value)) return null;
  const parsed = Date.parse(value.trim());
  const now = Date.now();
  if (!Number.isFinite(parsed) || parsed > now + MAX_CLOCK_SKEW_MS || now - parsed > maxAgeMs) return null;
  return new Date(parsed).toISOString();
}

function expectedVercelProductionOrigin() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  return host ? normalizeHttpsOrigin(`https://${host}`) : null;
}

const declaredProtectionOrigin = normalizeHttpsOrigin(process.env.SCENECART_OUTER_PROTECTION_ORIGIN);
const declaredProtectionProjectId = process.env.SCENECART_OUTER_PROTECTION_PROJECT_ID?.trim() ?? "";
const currentVercelProjectId = process.env.VERCEL_PROJECT_ID?.trim() ?? "";
const currentVercelProductionOrigin = expectedVercelProductionOrigin();
const outerProtectionConfigurationReady =
  process.env.SCENECART_ACCESS_MODE === "single_user" &&
  process.env.VERCEL_ENV === "production" &&
  process.env.SCENECART_OUTER_PROTECTION_VERIFIED === "true" &&
  process.env.SCENECART_OUTER_PROTECTION_SCOPE === "all_deployments" &&
  Boolean(recentIsoTimestamp(process.env.SCENECART_OUTER_PROTECTION_VERIFIED_AT, 30 * 24 * 60 * 60 * 1_000)) &&
  Boolean(declaredProtectionProjectId) &&
  declaredProtectionProjectId === currentVercelProjectId &&
  Boolean(declaredProtectionOrigin) &&
  formalOrigins(process.env.APP_ORIGIN).length === 1 &&
  formalOrigins(process.env.APP_ORIGIN)[0] === declaredProtectionOrigin &&
  currentVercelProductionOrigin === declaredProtectionOrigin;

function readLiveProtectionReceipt() {
  const receiptPath = process.env.SCENECART_OUTER_PROTECTION_AUDIT_RECEIPT?.trim();
  if (!receiptPath) return { valid: false, detail: "未提供独立 live 核验回执" };
  const absolutePath = path.isAbsolute(receiptPath) ? receiptPath : path.join(ROOT, receiptPath);
  try {
    const receipt = JSON.parse(fs.readFileSync(absolutePath, "utf-8"));
    const checks = receipt?.checks ?? {};
    const valid =
      receipt?.version === 1 &&
      receipt?.environment === "production" &&
      receipt?.project_id === declaredProtectionProjectId &&
      normalizeHttpsOrigin(receipt?.origin) === declaredProtectionOrigin &&
      configured(receipt?.deployment_id) &&
      Boolean(recentIsoTimestamp(receipt?.verified_at, LIVE_AUDIT_MAX_AGE_MS)) &&
      checks.vercel_protection_settings_observed === true &&
      checks.unauthenticated_page_challenged === true &&
      checks.unauthenticated_api_challenged === true &&
      checks.authorized_owner_page_succeeded === true &&
      checks.application_login_absent === true;
    return {
      valid,
      detail: valid
        ? "24 小时内的 Vercel 设置与匿名/授权 HTTP live 核验回执完整"
        : "live 核验回执字段不完整、已过期或与当前项目/origin 不匹配"
    };
  } catch {
    return { valid: false, detail: "无法读取或解析独立 live 核验回执" };
  }
}

const liveProtectionReceipt = readLiveProtectionReceipt();
const loginPageSource = fs.readFileSync(path.join(ROOT, "app/login/page.tsx"), "utf-8");
const loginRouteSource = fs.readFileSync(path.join(ROOT, "app/api/auth/login/route.ts"), "utf-8");
const registerRouteSource = fs.readFileSync(path.join(ROOT, "app/api/auth/register/route.ts"), "utf-8");
const interactiveAuthenticationClosed =
  loginPageSource.includes('permanentRedirect("/")') &&
  loginRouteSource.includes("410") &&
  registerRouteSource.includes("410") &&
  !loginRouteSource.includes("readJsonObject") &&
  !registerRouteSource.includes("readJsonObject");

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
    "database_tls",
    "PostgreSQL TLS 证书校验",
    process.env.DATABASE_SSL === "true" && process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false",
    process.env.DATABASE_SSL === "true" && process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false"
      ? "数据库 TLS 已启用且校验证书"
      : "数据库 TLS 未启用或证书校验被关闭",
    "设置 DATABASE_SSL=true、DATABASE_SSL_REJECT_UNAUTHORIZED=true；私有 CA 使用 DATABASE_SSL_CA"
  ),
  check(
    "fixed_single_user",
    "固定单用户访问",
    process.env.SCENECART_ACCESS_MODE === "single_user" && UUID_PATTERN.test(process.env.SCENECART_SINGLE_USER_ID ?? ""),
    process.env.SCENECART_ACCESS_MODE === "single_user" && UUID_PATTERN.test(process.env.SCENECART_SINGLE_USER_ID ?? "")
      ? "已配置 server-only 固定 owner；发布后仍须由 readiness 验证 owner 存在"
      : "未启用固定单用户访问或 owner UUID 无效",
    "设置 SCENECART_ACCESS_MODE=single_user 与既有 SCENECART_SINGLE_USER_ID"
  ),
  check(
    "interactive_authentication",
    "关闭应用登录与注册",
    interactiveAuthenticationClosed,
    interactiveAuthenticationClosed ? "/login 永久回首页，登录/注册 POST 在读取请求体前返回 410" : "仍存在应用登录或注册入口",
    "永久关闭 /login 与登录/注册 POST，并运行 auth 回归测试"
  ),
  check(
    "outer_protection_configuration",
    "外层保护服务端证明",
    outerProtectionConfigurationReady,
    outerProtectionConfigurationReady
      ? "保护声明、全部署范围、核验时间、项目 ID 与正式 origin 相符；该声明本身不等于线上已验证"
      : "外层保护声明、作用域、时间、项目 ID 或正式 origin 不完整",
    "现场核验 Vercel 保护后配置 server-only 证明；Production 必须使用 all_deployments"
  ),
  check(
    "outer_protection_live_audit",
    "外层保护 live 人工核验",
    liveProtectionReceipt.valid,
    liveProtectionReceipt.detail,
    "提供 24 小时内独立回执文件，记录 Vercel 设置、匿名页面/API 挑战、owner 成功访问及应用登录关闭；不能只设置环境变量"
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
    "app_origin",
    "HTTPS 正式域名",
    productionOrigins(process.env.APP_ORIGIN),
    productionOrigins(process.env.APP_ORIGIN) ? "APP_ORIGIN 均为正式 HTTPS 地址" : "APP_ORIGIN 缺失或仍包含本地/非 HTTPS 地址",
    "设置 APP_ORIGIN=https://你的正式域名"
  ),
  check(
    "public_demo_origin",
    "独立公开 Demo 域名",
    demoOriginSeparated,
    demoOriginSeparated ? "公开 Demo 与正式产品保持独立 origin" : "公开 Demo 地址无效或与正式产品 APP_ORIGIN 相同",
    "将 NEXT_PUBLIC_SCENECART_PUBLIC_DEMO_URL 设置为独立 HTTPS origin，不能复用 APP_ORIGIN"
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
