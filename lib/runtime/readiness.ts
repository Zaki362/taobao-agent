import { getExecutionBackend } from "@/lib/mcp/client";
import { isAuthenticationRequired, useSecureAuthCookie } from "@/lib/auth/request";
import { query } from "@/lib/runtime/database";
import { getRuntimeRepository, runtimeStoreMode } from "@/lib/runtime";
import { allowDemoCartFallback, getProductMode } from "@/lib/runtime/product-mode";

export type ReadinessStatus = "pass" | "fail" | "warn";

export interface RuntimeReadinessCheck {
  id: string;
  label: string;
  status: ReadinessStatus;
  required: boolean;
  detail: string;
  remediation?: string;
}

function check(
  id: string,
  label: string,
  status: ReadinessStatus,
  required: boolean,
  detail: string,
  remediation?: string
): RuntimeReadinessCheck {
  return { id, label, status, required, detail, remediation };
}

function configured(value: string | undefined) {
  return Boolean(value?.trim());
}

function validProductionOrigin(value: string | undefined) {
  if (!configured(value)) return false;
  return value!
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .every((origin) => /^https:\/\//i.test(origin) && !/localhost|127\.0\.0\.1/i.test(origin));
}

function onlineDevice(lastHeartbeatAt?: string) {
  if (!lastHeartbeatAt) return false;
  const heartbeat = Date.parse(lastHeartbeatAt);
  return Number.isFinite(heartbeat) && Date.now() - heartbeat < 45_000;
}

export async function inspectRuntimeReadiness(userId?: string) {
  const checks: RuntimeReadinessCheck[] = [];
  const store = runtimeStoreMode();
  const executor = getExecutionBackend();
  const authRequired = isAuthenticationRequired();
  const secureCookie = useSecureAuthCookie();
  const deepSeekConfigured = configured(process.env.DEEPSEEK_API_KEY) && process.env.DEEPSEEK_DISABLED !== "true";
  const productMode = getProductMode();
  const demoCartFallback = allowDemoCartFallback();

  checks.push(check(
    "product_mode",
    "产品运行模式",
    productMode === "production" ? "pass" : "fail",
    true,
    productMode === "production" ? "正在使用正式产品模式" : "当前仍是开发预览模式",
    "正式环境设置 SCENECART_PRODUCT_MODE=production"
  ));

  checks.push(check(
    "demo_cart_fallback",
    "演示加购回退",
    demoCartFallback ? "fail" : "pass",
    true,
    demoCartFallback
      ? "真实加购失败后仍允许写入产品内演示购物车"
      : "真实加购失败会明确返回失败，不会伪装成淘宝加购成功",
    "正式环境会强制关闭；开发环境可设置 ALLOW_DEMO_CART_FALLBACK=false"
  ));

  checks.push(check(
    "runtime_store",
    "持久化运行时",
    store === "postgres" ? "pass" : "fail",
    true,
    store === "postgres" ? "正在使用 PostgreSQL" : "当前仍使用进程内 local store",
    "设置 RUNTIME_STORE=postgres 和 DATABASE_URL，并执行 npm run db:migrate"
  ));

  if (store === "postgres") {
    try {
      await query("SELECT 1");
      checks.push(check("database", "数据库连接", "pass", true, "PostgreSQL 连接正常"));
    } catch {
      checks.push(check(
        "database",
        "数据库连接",
        "fail",
        true,
        "PostgreSQL 当前不可达",
        "检查 DATABASE_URL、网络和 migration 状态"
      ));
    }
  } else {
    checks.push(check(
      "database",
      "数据库连接",
      "fail",
      true,
      "未启用 PostgreSQL，无法验证正式数据库",
      "配置 DATABASE_URL 后执行 npm run db:migrate && npm run db:check"
    ));
  }

  checks.push(check(
    "authentication",
    "用户认证",
    authRequired ? "pass" : "fail",
    true,
    authRequired ? "AUTH_REQUIRED 已开启" : "当前允许匿名使用",
    "正式环境设置 AUTH_REQUIRED=true"
  ));
  checks.push(check(
    "secure_cookie",
    "安全会话 Cookie",
    secureCookie ? "pass" : "fail",
    true,
    secureCookie ? "会话 Cookie 仅通过安全连接发送" : "Secure Cookie 尚未开启",
    "使用 HTTPS，并设置 AUTH_COOKIE_SECURE=true"
  ));
  checks.push(check(
    "app_origin",
    "生产 Origin",
    validProductionOrigin(process.env.APP_ORIGIN) ? "pass" : "fail",
    true,
    validProductionOrigin(process.env.APP_ORIGIN)
      ? "APP_ORIGIN 已限制为 HTTPS 正式域名"
      : "APP_ORIGIN 缺失、使用本地地址或不是 HTTPS",
    "将 APP_ORIGIN 设置为正式 HTTPS 产品域名"
  ));
  checks.push(check(
    "executor_backend",
    "淘宝执行架构",
    executor === "local_executor" ? "pass" : "fail",
    true,
    executor === "local_executor"
      ? "真实淘宝操作通过持久任务和本地执行器运行"
      : `当前 backend=${executor}，仍是开发兼容路径`,
    "正式环境设置 TAOBAO_EXECUTION_BACKEND=local_executor"
  ));
  checks.push(check(
    "legacy_mock_mode",
    "旧 Mock 配置",
    process.env.TAOBAO_MCP_MODE === "mock" ? "fail" : "pass",
    true,
    process.env.TAOBAO_MCP_MODE === "mock"
      ? "仍存在 TAOBAO_MCP_MODE=mock"
      : "未启用旧 MCP mock 标志",
    "从正式环境删除 TAOBAO_MCP_MODE，执行模式只由 TAOBAO_EXECUTION_BACKEND 决定"
  ));
  checks.push(check(
    "deepseek",
    "DeepSeek 模型",
    deepSeekConfigured ? "pass" : "fail",
    true,
    deepSeekConfigured ? "DeepSeek Key 已配置，模型未被显式禁用" : "DeepSeek 未配置或已被禁用",
    "配置 DEEPSEEK_API_KEY，并确保 DEEPSEEK_DISABLED 不是 true"
  ));

  if (userId) {
    const devices = await getRuntimeRepository().listDevices(userId);
    const onlineCount = devices.filter((device) => device.status !== "revoked" && onlineDevice(device.last_heartbeat_at)).length;
    checks.push(check(
      "executor_online",
      "本地执行器在线",
      onlineCount > 0 ? "pass" : "warn",
      false,
      onlineCount > 0 ? `${onlineCount} 台本地执行器在线` : "当前账号没有在线执行器",
      "在淘宝与 Qoder 所在电脑运行 npm run executor:doctor 和 npm run worker:local"
    ));
  } else {
    checks.push(check(
      "executor_online",
      "本地执行器在线",
      "warn",
      false,
      "登录后才能检查当前账号的执行器",
      "登录产品并打开 /settings/executor"
    ));
  }

  const readyForProduction = checks.every((item) => !item.required || item.status === "pass");
  const executorReady = checks.find((item) => item.id === "executor_online")?.status === "pass";
  return {
    product_mode: productMode,
    demo_cart_fallback: demoCartFallback,
    ready_for_production: readyForProduction,
    operational_for_shopping: readyForProduction && executorReady,
    checked_at: new Date().toISOString(),
    checks
  };
}
