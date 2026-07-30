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
  };
  devices: {
    online: number;
  };
  llm: {
    calls: number;
    connected: number;
    fallback: number;
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

  if (queuedWork > 0 && input.devices.online === 0) {
    incidents.push(incident(
      "executor_offline_with_work",
      "critical",
      "有任务等待，但本地执行器离线",
      `当前有 ${queuedWork} 个待执行或执行中任务，没有在线设备领取。`,
      "在淘宝与 Qoder 所在电脑运行 executor:doctor，确认全部通过后启动 worker:local。"
    ));
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
