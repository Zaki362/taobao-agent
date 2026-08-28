import { getConfiguredExecutionBackend, getExecutionBackend } from "@/lib/mcp/client";
import {
  getSceneCartAccessMode,
  inspectConfiguredSingleUserOwner
} from "@/lib/auth/access-mode";
import {
  inspectSingleUserExposureConfiguration
} from "@/lib/auth/outer-protection";
import { isAuthenticationRequired, shouldUseSecureAuthCookie } from "@/lib/auth/request";
import { query } from "@/lib/runtime/database";
import { getRuntimeRepository, runtimeStoreMode } from "@/lib/runtime";
import { allowDemoCartFallback, getProductMode, isMcpDebugEnabled } from "@/lib/runtime/product-mode";
import { summarizeExecutorDevices } from "@/lib/runtime/executor-status";
import { summarizeLlmRuntimeStatus } from "@/lib/llm/telemetry";
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

type NullOwnerIntegrityRow = {
  table_name: "shopping_sessions" | "agent_jobs" | "execution_events";
  null_owner_count: string | number;
};

export function summarizeNullOwnerIntegrity(rows: NullOwnerIntegrityRow[]) {
  const counts = new Map(rows.map((row) => [row.table_name, Number(row.null_owner_count) || 0]));
  const shoppingSessions = counts.get("shopping_sessions") ?? 0;
  const agentJobs = counts.get("agent_jobs") ?? 0;
  const executionEvents = counts.get("execution_events") ?? 0;
  const total = shoppingSessions + agentJobs + executionEvents;
  return {
    valid: total === 0,
    total,
    counts: { shoppingSessions, agentJobs, executionEvents }
  };
}

async function inspectNullOwnerIntegrity() {
  const result = await query<NullOwnerIntegrityRow>(`
    SELECT 'shopping_sessions' AS table_name, COUNT(*)::bigint AS null_owner_count
      FROM shopping_sessions
     WHERE user_id IS NULL
       AND COALESCE(NULLIF(state->>'archived_at', ''), '') = ''
    UNION ALL
    SELECT 'agent_jobs' AS table_name, COUNT(*)::bigint AS null_owner_count
      FROM agent_jobs
     WHERE user_id IS NULL
       AND status IN ('pending', 'leased', 'running')
    UNION ALL
    SELECT 'execution_events' AS table_name, COUNT(*)::bigint AS null_owner_count
      FROM execution_events
     WHERE user_id IS NULL
  `);
  return summarizeNullOwnerIntegrity(result.rows);
}

export async function inspectRuntimeReadiness(userId?: string) {
  const checks: RuntimeReadinessCheck[] = [];
  const store = runtimeStoreMode();
  const executor = getExecutionBackend();
  const configuredExecutor = getConfiguredExecutionBackend();
  const authConfigured = process.env.AUTH_REQUIRED === "true";
  const accessMode = getSceneCartAccessMode();
  const singleUserExposure = accessMode === "single_user"
    ? inspectSingleUserExposureConfiguration()
    : null;
  const localSingleUserDevelopment = singleUserExposure?.mode === "local_development";
  const outerProtection = singleUserExposure?.outerProtection ?? null;
  let authRequired = false;
  let authRequirementError = "";
  if (accessMode !== "single_user") {
    try {
      authRequired = isAuthenticationRequired();
    } catch (error) {
      authRequirementError = error instanceof Error ? error.message : "身份策略校验失败";
    }
  }
  let singleUserOwnerReady = false;
  let singleUserOwnerDetail = "";
  let singleUserOwner: Awaited<ReturnType<typeof inspectConfiguredSingleUserOwner>> = null;
  if (accessMode === "single_user") {
    try {
      singleUserOwner = await inspectConfiguredSingleUserOwner();
      singleUserOwnerReady = Boolean(singleUserOwner);
      singleUserOwnerDetail = singleUserOwner
        ? "固定 owner 已存在；会话、设备和任务均由服务端绑定，不向浏览器公开身份标识"
        : "单用户 owner 未配置";
    } catch (error) {
      singleUserOwnerDetail = error instanceof Error ? error.message : "单用户 owner 校验失败";
    }
  }
  const secureCookieConfigured = process.env.AUTH_COOKIE_SECURE === "true";
  const secureCookie = shouldUseSecureAuthCookie();
  const deepSeekConfigured = configured(process.env.DEEPSEEK_API_KEY) && process.env.DEEPSEEK_DISABLED !== "true";
  const llmRuntime = summarizeLlmRuntimeStatus();
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

  if (store === "postgres") {
    try {
      const integrity = await inspectNullOwnerIntegrity();
      checks.push(check(
        "owner_integrity",
        "Owner 数据完整性",
        integrity.valid ? "pass" : "fail",
        true,
        integrity.valid
          ? "活动购物会话、活动任务和执行事件均已绑定 owner"
          : `发现 ${integrity.total} 条缺少 owner 的活动或审计数据（会话 ${integrity.counts.shoppingSessions}、任务 ${integrity.counts.agentJobs}、事件 ${integrity.counts.executionEvents}）`,
        "先迁移或隔离所有 null-owner 数据，再开放固定单用户正式访问"
      ));
    } catch {
      checks.push(check(
        "owner_integrity",
        "Owner 数据完整性",
        "fail",
        true,
        "无法完成 null-owner 数据完整性检查",
        "确认三张运行时表已迁移且数据库账号具备只读检查权限"
      ));
    }
  } else {
    checks.push(check(
      "owner_integrity",
      "Owner 数据完整性",
      "fail",
      true,
      "未启用 PostgreSQL，无法检查 null-owner 运行时数据",
      "启用 PostgreSQL 后检查 shopping_sessions、agent_jobs 和 execution_events"
    ));
  }

  const singleUserPolicyReady = accessMode === "single_user" && singleUserExposure?.valid === true;

  checks.push(check(
    "access_mode",
    "固定单用户访问模式",
    accessMode === "single_user" ? "pass" : "fail",
    true,
    accessMode === "single_user"
      ? "正式界面使用固定单用户访问，应用登录与注册入口关闭"
      : "当前仍是账号或匿名访问模式",
    "设置 SCENECART_ACCESS_MODE=single_user；该变量本身不足以开放访问"
  ));

  checks.push(check(
    "fixed_owner",
    "固定 Owner",
    singleUserOwnerReady ? "pass" : "fail",
    true,
    singleUserOwnerDetail || "固定 owner 尚未通过服务端校验",
    "配置已存在的 SCENECART_SINGLE_USER_ID，并确认 PostgreSQL 中 owner 存在"
  ));

  checks.push(check(
    "single_user_exposure_policy",
    "固定单用户暴露策略",
    singleUserPolicyReady ? "pass" : "fail",
    true,
    singleUserExposure?.mode === "unprotected_risk_accepted"
      ? "已明确接受固定 owner 在无 Vercel 外层保护的 Production 域名公开访问风险"
      : singleUserExposure?.mode === "protected"
        ? "固定 owner 仅通过经核验的 Vercel 外层保护访问"
        : localSingleUserDevelopment
          ? "仅限本机 loopback 开发访问"
          : `固定单用户暴露策略无效：${singleUserExposure?.issues.join("；") || "未配置"}`,
    "配置经核验的 Vercel 外层保护，或仅在知情接受风险后启用公开单用户 Production 开关"
  ));

  const outerProtectionStatus: ReadinessStatus = singleUserExposure?.mode === "unprotected_risk_accepted"
    ? "warn"
    : (localSingleUserDevelopment || outerProtection?.valid) ? "pass" : "fail";
  checks.push(check(
    "outer_protection",
    "Vercel 外层访问保护",
    outerProtectionStatus,
    singleUserExposure?.mode !== "unprotected_risk_accepted",
    localSingleUserDevelopment
      ? "仅限本地开发；远程 Preview/Production 仍必须提供人工核验声明"
      : singleUserExposure?.mode === "unprotected_risk_accepted"
        ? "未验证 Vercel 外层保护；知道固定域名的人可以直接进入同一个固定 owner 产品，风险已由用户明确接受"
      : outerProtection?.valid
        ? "服务端保护声明、范围、时间、项目 ID 与正式 origin 相符；发布前仍须提交独立 live 核验回执"
        : `外层保护证明不完整：${outerProtection?.issues.join("；") || "未检测到 Vercel 保护环境"}`,
    "升级并启用 Vercel All Deployments Protection 可消除此公开访问风险"
  ));

  checks.push(check(
    "authentication",
    "访问身份",
    accessMode === "single_user"
      ? (singleUserOwnerReady && singleUserPolicyReady ? "pass" : "fail")
      : (authConfigured && authRequired ? "pass" : "fail"),
    true,
    accessMode === "single_user"
      ? singleUserOwnerDetail
      : authConfigured
        ? "AUTH_REQUIRED 已开启"
        : authRequirementError
          ? authRequirementError
        : authRequired
          ? "正式模式已强制账号隔离，但 AUTH_REQUIRED 尚未显式配置"
          : "当前允许匿名使用",
    accessMode === "single_user"
      ? "补齐固定 owner 与有效的服务端暴露策略"
      : "正式环境设置 AUTH_REQUIRED=true"
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
    accessMode === "single_user"
      ? "pass"
      : secureCookieConfigured && secureCookie ? "pass" : "fail",
    true,
    accessMode === "single_user"
      ? "应用登录已关闭，固定单用户访问不创建浏览器会话 Cookie"
      : secureCookieConfigured
      ? "会话 Cookie 仅通过安全连接发送"
      : secureCookie
        ? "HTTPS Origin 已强制使用 Secure Cookie，但 AUTH_COOKIE_SECURE 尚未显式配置"
        : "Secure Cookie 尚未开启",
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
      : executor === "local_executor"
        ? `已阻断已退役或当前模式不允许的 backend=${configuredExecutor}；运行时安全回退到 local_executor，但仍需修正配置`
        : `当前 backend=${configuredExecutor}，仅允许开发期历史任务兼容`,
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

  const llmRuntimeStatus: ReadinessStatus = !deepSeekConfigured || llmRuntime.state === "unavailable"
    ? "fail"
    : llmRuntime.state === "connected"
      ? "pass"
      : "warn";
  const llmRuntimeDetail = !deepSeekConfigured
    ? "模型尚未配置，当前只能使用确定性 fallback"
    : llmRuntime.state === "unverified"
      ? "模型已配置，但本进程启动后尚未产生真实调用证据"
      : llmRuntime.state === "unavailable"
        ? `${llmRuntime.calls} 次模型任务全部进入 fallback，最近原因：${llmRuntime.last_reason ?? "未知"}`
        : llmRuntime.state === "degraded"
          ? `${llmRuntime.calls} 次模型任务中 ${llmRuntime.fallback} 次进入 fallback，最近原因：${llmRuntime.last_reason ?? "已恢复"}`
          : `${llmRuntime.connected} / ${llmRuntime.calls} 次模型任务真实成功，最近使用 ${llmRuntime.last_model ?? "DeepSeek"}`;
  checks.push(check(
    "deepseek_runtime",
    "DeepSeek 真实运行状态",
    llmRuntimeStatus,
    false,
    llmRuntimeDetail,
    "先完成一次需求理解；如持续降级，请检查 DeepSeek Key、网络、超时和严格 JSON 校验原因"
  ));

  let executorCapabilities = summarizeExecutorDevices([]);
  const readinessUserId = accessMode === "single_user" ? singleUserOwner?.id : userId;
  const canInspectUserRuntime = Boolean(
    readinessUserId && (productMode !== "production" || store === "postgres")
  );
  if (readinessUserId && canInspectUserRuntime) {
    const devices = await getRuntimeRepository().listDevices(readinessUserId);
    executorCapabilities = summarizeExecutorDevices(devices);
    checks.push(check(
      "executor_online",
      "本地执行器在线",
      executorCapabilities.online > 0 ? "pass" : "warn",
      false,
      executorCapabilities.online > 0
        ? `${executorCapabilities.online} 台本地执行器在线`
        : executorCapabilities.authentication_required > 0
          ? `${executorCapabilities.authentication_required} 台本地执行器正在等待淘宝重新登录`
          : executorCapabilities.mcp_unavailable > 0
            ? `${executorCapabilities.mcp_unavailable} 台本地执行器正在等待淘宝桌面版工具恢复`
          : "当前账号没有在线执行器",
      "保持淘宝桌面版主界面打开；npm run dev 会自动重连，也可运行 npm run executor:doctor 定位原因"
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
    const unavailableDetail = readinessUserId
      ? "正式运行时配置未通过，暂不读取当前账号的执行器能力"
      : "登录后才能检查当前账号的执行器能力";
    const unavailableRemediation = readinessUserId
      ? "先配置 RUNTIME_STORE=postgres 和 DATABASE_URL"
      : "登录产品并打开 /settings/executor";
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
        unavailableDetail,
        unavailableRemediation
      ));
    }
  }

  const operationalConfigurationReady = checks.every((item) => !item.required || item.status === "pass");
  const protectedProduction = singleUserExposure?.mode === "protected" &&
    outerProtection?.environment === "production" &&
    outerProtection.scope === "all_deployments";
  const unprotectedProductionRiskAccepted = singleUserExposure?.mode === "unprotected_risk_accepted";
  const readyForProduction = operationalConfigurationReady &&
    accessMode === "single_user" &&
    (protectedProduction || unprotectedProductionRiskAccepted);
  const executorReady =
    executorCapabilities.capabilities.module_search.available &&
    executorCapabilities.capabilities.add_to_cart.available;
  return {
    product_mode: productMode,
    access_mode: accessMode,
    demo_cart_fallback: demoCartFallback,
    mcp_debug_enabled: isMcpDebugEnabled(),
    configured_executor_backend: configuredExecutor,
    effective_executor_backend: executor,
    single_user_exposure_mode: singleUserExposure?.mode ?? "invalid",
    outer_protection_verified: outerProtection?.valid === true,
    unprotected_risk_accepted: unprotectedProductionRiskAccepted,
    ready_for_production: readyForProduction,
    operational_for_shopping: operationalConfigurationReady && executorReady,
    executor_capabilities: executorCapabilities,
    workflow_recovery: {
      configured: workflowRecoveryConfigured,
      ...workflowRecovery
    },
    llm_runtime: llmRuntime,
    checked_at: new Date().toISOString(),
    checks
  };
}
