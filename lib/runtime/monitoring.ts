import type { AgentRuntimeState } from "@/lib/session/types";

export type RuntimeHealthStatus = "healthy" | "warning" | "critical";
export type RuntimeIncidentSeverity = "warning" | "critical";

export interface RuntimeIncident {
  code: string;
  severity: RuntimeIncidentSeverity;
  title: string;
  detail: string;
  recommendation: string;
}

interface RuntimeHealthInput {
  jobs: {
    pending: number;
    active: number;
    completed: number;
    failed: number;
    oldest_pending_ms: number;
    pending_by_type?: {
      module_search: number;
      add_to_cart: number;
    };
  };
  devices: {
    online: number;
    capabilities?: {
      module_search: { online: number };
      add_to_cart: { online: number };
    };
  };
  llm: {
    calls: number;
    connected: number;
    fallback: number;
    tasks?: Array<{
      task: string;
      calls: number;
      p95_duration_ms: number;
      last_reason?: string;
    }>;
  };
  workflowRecovery?: {
    configured: boolean;
    state: "missing" | "stale" | "healthy" | "degraded" | "failed";
    last_heartbeat_at: string | null;
  };
  agentRuntime: AgentRuntimeState;
}

function incident(
  code: string,
  severity: RuntimeIncidentSeverity,
  title: string,
  detail: string,
  recommendation: string
): RuntimeIncident {
  return { code, severity, title, detail, recommendation };
}

export function evaluateRuntimeHealth(input: RuntimeHealthInput) {
  const incidents: RuntimeIncident[] = [];
  const queuedWork = input.jobs.pending + input.jobs.active;

  if (input.workflowRecovery?.configured) {
    if (input.workflowRecovery.state === "missing" || input.workflowRecovery.state === "stale") {
      incidents.push(incident(
        "workflow_recovery_offline",
        "critical",
        "服务端恢复调度未持续运行",
        input.workflowRecovery.state === "missing"
          ? "恢复调度已配置，但从未记录成功心跳。"
          : `恢复调度心跳已过期，最后记录于 ${input.workflowRecovery.last_heartbeat_at ?? "未知时间"}。`,
        "检查 worker:recovery 或云端 Cron，并验证内部恢复端点可以持续返回成功。"
      ));
    } else if (input.workflowRecovery.state === "failed") {
      incidents.push(incident(
        "workflow_recovery_failed",
        "critical",
        "最近一次服务端恢复扫描失败",
        `恢复调度最近一次执行失败，时间 ${input.workflowRecovery.last_heartbeat_at ?? "未知"}。`,
        "检查恢复 Worker 日志、数据库连接和内部恢复 API。"
      ));
    } else if (input.workflowRecovery.state === "degraded") {
      incidents.push(incident(
        "workflow_recovery_degraded",
        "warning",
        "部分工作流恢复失败",
        `恢复调度仍在线，但最近一批存在无法恢复的会话，时间 ${input.workflowRecovery.last_heartbeat_at ?? "未知"}。`,
        "在执行台定位 recovery_failed 会话并检查其 Agent 决策或持久任务状态。"
      ));
    }
  }

  if (queuedWork > 0 && input.devices.online === 0) {
    incidents.push(incident(
      "executor_offline_with_work",
      "critical",
      "有任务等待，但本地执行器离线",
      `当前有 ${queuedWork} 个待执行或执行中任务，没有在线设备领取。`,
      "在淘宝与 Qoder 所在电脑运行 executor:doctor，确认全部通过后启动 worker:local。"
    ));
  }

  if (input.devices.online > 0) {
    const pendingSearch = input.jobs.pending_by_type?.module_search ?? 0;
    const pendingCart = input.jobs.pending_by_type?.add_to_cart ?? 0;
    if (pendingSearch > 0 && (input.devices.capabilities?.module_search.online ?? 0) === 0) {
      incidents.push(incident(
        "search_capability_unavailable",
        "critical",
        "搜索任务没有匹配的执行器",
        `当前有 ${pendingSearch} 个淘宝搜索任务等待，但在线设备均未声明 module_search 能力。`,
        "在执行器设置页注册搜索能力，或启动具备 module_search 能力的本地 Worker。"
      ));
    }
    if (pendingCart > 0 && (input.devices.capabilities?.add_to_cart.online ?? 0) === 0) {
      incidents.push(incident(
        "cart_capability_unavailable",
        "critical",
        "加购任务没有匹配的执行器",
        `当前有 ${pendingCart} 个已确认加购任务等待，但在线设备均未声明 add_to_cart 能力。`,
        "确认淘宝账号支持加购后，启动具备 add_to_cart 能力的本地 Worker。"
      ));
    }
  }

  if (input.jobs.oldest_pending_ms >= 180_000) {
    incidents.push(incident(
      "queue_stalled",
      "critical",
      "任务队列长时间未推进",
      `最久等待任务已超过 ${Math.round(input.jobs.oldest_pending_ms / 60_000)} 分钟。`,
      "检查执行器登录状态、任务租约和 Qoder 输出；必要时取消尚未领取的任务后重试。"
    ));
  } else if (input.jobs.oldest_pending_ms >= 60_000) {
    incidents.push(incident(
      "queue_slow",
      "warning",
      "任务队列等待偏久",
      `最久等待任务已达到 ${Math.round(input.jobs.oldest_pending_ms / 1_000)} 秒。`,
      "确认本地执行器在线，并观察任务是否进入 leased/running 状态。"
    ));
  }

  const terminalJobs = input.jobs.completed + input.jobs.failed;
  const failureRate = terminalJobs > 0 ? input.jobs.failed / terminalJobs : 0;
  if (terminalJobs >= 3 && failureRate >= 0.5) {
    incidents.push(incident(
      "job_failure_rate_critical",
      "critical",
      "真实执行失败率过高",
      `${terminalJobs} 个已结束任务中有 ${input.jobs.failed} 个失败。`,
      "暂停继续派发任务，先检查 Qoder 登录、淘宝 skill 和失败日志中的首个根因。"
    ));
  } else if (terminalJobs >= 3 && failureRate >= 0.25) {
    incidents.push(incident(
      "job_failure_rate_warning",
      "warning",
      "真实执行失败率升高",
      `${terminalJobs} 个已结束任务中有 ${input.jobs.failed} 个失败。`,
      "检查失败任务是否集中在同一模块、同一账号动作或同一执行器版本。"
    ));
  }

  const fallbackRate = input.llm.calls > 0 ? input.llm.fallback / input.llm.calls : 0;
  if (input.llm.calls >= 3 && fallbackRate >= 0.8) {
    incidents.push(incident(
      "llm_fallback_critical",
      "critical",
      "模型能力基本处于降级状态",
      `${input.llm.calls} 次模型任务中有 ${input.llm.fallback} 次使用 fallback。`,
      "检查 DeepSeek Key、网络、超时和严格 JSON 校验失败原因。"
    ));
  } else if (input.llm.calls >= 3 && fallbackRate >= 0.4) {
    incidents.push(incident(
      "llm_fallback_warning",
      "warning",
      "模型 fallback 比例偏高",
      `${input.llm.calls} 次模型任务中有 ${input.llm.fallback} 次使用 fallback。`,
      "按任务查看 last_reason，优先优化高延迟或结构校验失败的 Prompt。"
    ));
  }

  const slowTaskThresholds: Record<string, number> = {
    parse_scene: 12_000,
    personalize_template: 23_000,
    refine_plan: 16_000,
    review_candidates: 7_000,
    review_plan: 9_000,
    decide_next_action: 13_000,
    explain_product_fit: 5_000
  };
  for (const task of input.llm.tasks ?? []) {
    const threshold = slowTaskThresholds[task.task];
    if (!threshold || task.calls < 3 || task.p95_duration_ms < threshold) continue;
    incidents.push(incident(
      `llm_latency_${task.task}`,
      "warning",
      `模型任务 ${task.task} 响应偏慢`,
      `${task.calls} 次调用的 P95 耗时为 ${Math.round(task.p95_duration_ms / 1_000)} 秒，已接近该任务的等待上限。`,
      task.last_reason === "timeout"
        ? "检查 DeepSeek 网络与模型选择；不要直接放大超时，先确认 Prompt 体积和响应 schema。"
        : "检查该任务 Prompt、模型选择与返回体大小，并结合最近 fallback 原因定位。"
    ));
  }

  const modelProposals = input.agentRuntime.model_proposals;
  const rejectionRate = modelProposals > 0
    ? input.agentRuntime.model_rejections / modelProposals
    : 0;
  if (modelProposals >= 3 && rejectionRate >= 0.5) {
    incidents.push(incident(
      "agent_guardrail_rejections",
      "warning",
      "模型动作频繁被 Guardrail 拒绝",
      `${modelProposals} 次模型提议中有 ${input.agentRuntime.model_rejections} 次被拒绝。`,
      "检查动作 Prompt、模块 ID、置信度阈值和工具预算是否与当前规划一致。"
    ));
  }

  const status: RuntimeHealthStatus = incidents.some((item) => item.severity === "critical")
    ? "critical"
    : incidents.length > 0
      ? "warning"
      : "healthy";

  return {
    status,
    incidents,
    summary: status === "healthy"
      ? "当前会话没有检测到运行异常。"
      : status === "critical"
        ? "当前会话存在需要立即处理的执行异常。"
        : "当前会话存在需要关注的运行趋势。"
  };
}
