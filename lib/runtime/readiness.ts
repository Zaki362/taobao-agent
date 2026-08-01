import { getConfiguredExecutionBackend, getExecutionBackend } from "@/lib/mcp/client";
import { isAuthenticationRequired, useSecureAuthCookie } from "@/lib/auth/request";
import { query } from "@/lib/runtime/database";
import { getRuntimeRepository, runtimeStoreMode } from "@/lib/runtime";
import { allowDemoCartFallback, getProductMode, isMcpDebugEnabled } from "@/lib/runtime/product-mode";
import { summarizeExecutorDevices } from "@/lib/runtime/executor-status";
import {
  summarizeWorkflowRecoveryHeartbeat,
  WORKFLOW_RECOVERY_SERVICE
} from "@/lib/runtime/recovery-heartbeat";

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

export async function inspectRuntimeReadiness(userId?: string) {
  const checks: RuntimeReadinessCheck[] = [];
  const store = runtimeStoreMode();
  const executor = getExecutionBackend();
  const configuredExecutor = getConfiguredExecutionBackend();
  const authRequired = isAuthenticationRequired();
  const secureCookie = useSecureAuthCookie();
  const deepSeekConfigured = configured(process.env.DEEPSEEK_API_KEY) && process.env.DEEPSEEK_DISABLED !== "true";
  const productMode = getProductMode();
  const demoCartFallback = allowDemoCartFallback();
  const mcpDebugConfigured = process.env.SCENECART_ENABLE_MCP_DEBUG === "true";
  const workflowRecoveryConfigured = (process.env.SCENECART_CRON_SECRET?.trim().length ?? 0) >= 32;
  const workflowRecoveryHeartbeat = workflowRecoveryConfigured
    ? await getRuntimeRepository().getServiceHeartbeat(WORKFLOW_RECOVERY_SERVICE).catch(() => null)
    : null;
  const workflowRecovery = summarizeWorkflowRecoveryHeartbeat(workflowRecoveryHeartbeat);

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
  const workflowRecoveryStatus: ReadinessStatus = !workflowRecoveryConfigured
    ? "fail"
    : workflowRecovery.state === "healthy"
      ? "pass"
      : workflowRecovery.state === "degraded"
        ? "warn"
        : "fail";
  const workflowRecoveryDetail = !workflowRecoveryConfigured
    ? "未配置服务端恢复扫描密钥，进程中断后的续跑仍可能依赖本地执行器"
    : workflowRecovery.state === "missing"
      ? "恢复调度已配置，但尚未收到 Worker 或 Cron 心跳"
      : workflowRecovery.state === "stale"
        ? `恢复调度心跳已过期，最后一次运行在 ${workflowRecovery.last_heartbeat_at ?? "未知时间"}`
        : workflowRecovery.state === "failed"
          ? `最近一次恢复扫描失败，时间 ${workflowRecovery.last_heartbeat_at ?? "未知"}`
          : workflowRecovery.state === "degraded"
            ? `恢复调度在线，但最近一批存在失败会话，时间 ${workflowRecovery.last_heartbeat_at ?? "未知"}`
            : `恢复调度运行正常，最近心跳 ${workflowRecovery.last_heartbeat_at ?? "未知"}`;
  checks.push(check(
    "workflow_recovery",
    "服务端工作流恢复",
    workflowRecoveryStatus,
    true,
    workflowRecoveryDetail,
    "设置 SCENECART_CRON_SECRET，并确认 worker:recovery 或云端 Cron 持续调用内部恢复端点"
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
    configuredExecutor === "local_executor" ? "pass" : "fail",
    true,
    configuredExecutor === "local_executor"
      ? "真实淘宝操作通过持久任务和本地执行器运行"
      : productMode === "production" && executor === "local_executor"
        ? `已阻断配置的 backend=${configuredExecutor}；运行时安全回退到 local_executor，但仍需修正配置`
        : `当前 backend=${configuredExecutor}，仍是开发兼容路径`,
    "正式环境设置 TAOBAO_EXECUTION_BACKEND=local_executor"
  ));
  checks.push(check(
    "legacy_hosted_worker",
    "旧宿主执行通道",
    !configured(process.env.HOSTED_WORKER_TOKEN) ? "pass" : "fail",
    true,
    !configured(process.env.HOSTED_WORKER_TOKEN)
      ? "未配置旧 Codex hosted Worker Token，正式任务只走设备协议"
      : "仍配置 HOSTED_WORKER_TOKEN；production 虽会拒绝访问，但应移除旧令牌",
    "从正式环境删除 HOSTED_WORKER_TOKEN，并停止 worker:codex"
  ));
  checks.push(check(
    "mcp_debug_endpoint",
    "手动 MCP 调试端点",
    mcpDebugConfigured ? "fail" : "pass",
    true,
    mcpDebugConfigured
      ? "仍配置 SCENECART_ENABLE_MCP_DEBUG=true；生产运行时虽然会拒绝访问，但发布配置应显式关闭"
      : "手动 MCP 调试端点默认关闭，购物工具只能通过 Agent 工作流与持久任务执行",
    "设置 SCENECART_ENABLE_MCP_DEBUG=false"
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

  let executorCapabilities = summarizeExecutorDevices([]);
  if (userId) {
    const devices = await getRuntimeRepository().listDevices(userId);
    executorCapabilities = summarizeExecutorDevices(devices);
    checks.push(check(
      "executor_online",
      "本地执行器在线",
      executorCapabilities.online > 0 ? "pass" : "warn",
      false,
      executorCapabilities.online > 0 ? `${executorCapabilities.online} 台本地执行器在线` : "当前账号没有在线执行器",
      "在淘宝与 Qoder 所在电脑运行 npm run executor:doctor 和 npm run worker:local"
    ));
    checks.push(check(
      "executor_search_capability",
      "真实商品搜索能力",
      executorCapabilities.capabilities.module_search.available ? "pass" : "warn",
      false,
      executorCapabilities.capabilities.module_search.available
        ? `${executorCapabilities.capabilities.module_search.online} 台在线设备可执行淘宝搜索`
        : "当前没有具备商品搜索能力的在线设备",
      "注册包含 module_search 能力的设备，并启动对应本地执行器"
    ));
    checks.push(check(
      "executor_cart_capability",
      "真实淘宝加购能力",
      executorCapabilities.capabilities.add_to_cart.available ? "pass" : "warn",
      false,
      executorCapabilities.capabilities.add_to_cart.available
        ? `${executorCapabilities.capabilities.add_to_cart.online} 台在线设备可执行显式确认后的真实加购`
        : "当前没有具备真实加购能力的在线设备",
      "确认淘宝账号与 Skill 支持加购，再注册包含 add_to_cart 能力的设备"
    ));
  } else {
    for (const [id, label] of [
      ["executor_online", "本地执行器在线"],
      ["executor_search_capability", "真实商品搜索能力"],
      ["executor_cart_capability", "真实淘宝加购能力"]
    ] as const) {
      checks.push(check(
        id,
        label,
        "warn",
        false,
        "登录后才能检查当前账号的执行器能力",
        "登录产品并打开 /settings/executor"
      ));
    }
  }

  const readyForProduction = checks.every((item) => !item.required || item.status === "pass");
  const executorReady =
    executorCapabilities.capabilities.module_search.available &&
    executorCapabilities.capabilities.add_to_cart.available;
  return {
    product_mode: productMode,
    demo_cart_fallback: demoCartFallback,
    mcp_debug_enabled: isMcpDebugEnabled(),
    configured_executor_backend: configuredExecutor,
    effective_executor_backend: executor,
    ready_for_production: readyForProduction,
    operational_for_shopping: readyForProduction && executorReady,
    executor_capabilities: executorCapabilities,
    workflow_recovery: {
      configured: workflowRecoveryConfigured,
      ...workflowRecovery
    },
    checked_at: new Date().toISOString(),
    checks
  };
}
