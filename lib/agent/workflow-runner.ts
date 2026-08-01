import { randomUUID } from "node:crypto";
import {
  consumeAgentDecision,
  pendingAgentDecision,
  recordAgentDecision,
  removeModuleAgentDecisions
} from "@/lib/agent/decision-engine";
import { buildAgentCompletionReport } from "@/lib/agent/completion-review";
import { composePurchaseBundle } from "@/lib/llm/deepseek";
import { runModuleSearch } from "@/lib/agent/product-matcher";
import { decideNextAgentActionV2 } from "@/lib/agent/runtime-v2";
import { getRuntimeRepository } from "@/lib/runtime";
import { withWorkflowSessionLock, withWorkflowSessionTransaction } from "@/lib/runtime/database";
import { loadSession, persistSession } from "@/lib/session/repository";
import { invalidateAgentCompletionArtifacts } from "@/lib/session/bundle-adoption";
import { appendSessionLlmCalls } from "@/lib/llm/session-evidence";
import type { AgentDecision, SessionState } from "@/lib/session/types";

export type AgentWorkflowTrigger =
  | "user_start"
  | "user_pause"
  | "user_resume"
  | "user_recover_gaps"
  | "user_improve_quality"
  | "job_completed"
  | "job_failed"
  | "legacy_task_resolved"
  | "recovery";

export interface AgentWorkflowAdvanceResult {
  state: SessionState;
  decision?: AgentDecision;
  outcome: "queued" | "waiting" | "completed" | "paused" | "no_op";
}

export class AgentCompletionRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCompletionRecoveryError";
  }
}

export class AgentWorkflowControlError extends Error {
  constructor(
    message: string,
    public readonly code: "workflow_not_running" | "workflow_not_paused"
  ) {
    super(message);
    this.name = "AgentWorkflowControlError";
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __SCENECART_WORKFLOW_RUNNERS__: Map<string, Promise<AgentWorkflowAdvanceResult>> | undefined;
}

const activeRunners = globalThis.__SCENECART_WORKFLOW_RUNNERS__ ?? new Map<string, Promise<AgentWorkflowAdvanceResult>>();
globalThis.__SCENECART_WORKFLOW_RUNNERS__ = activeRunners;

const MAX_NON_TOOL_TRANSITIONS = 16;

function transition(
  state: SessionState,
  input: {
    status: SessionState["agent_runtime"]["workflow_status"];
    message: string;
    moduleId?: string;
    autoContinue?: boolean;
  }
) {
  state.agent_runtime.workflow_status = input.status;
  state.agent_runtime.workflow_message = input.message;
  state.agent_runtime.current_module_id = input.moduleId;
  state.agent_runtime.last_transition_at = new Date().toISOString();
  if (input.autoContinue !== undefined) {
    state.agent_runtime.auto_continue = input.autoContinue;
  }
}

async function emitWorkflowEvent(
  state: SessionState,
  trigger: AgentWorkflowTrigger,
  outcome: AgentWorkflowAdvanceResult["outcome"],
  decision?: AgentDecision
) {
  await getRuntimeRepository().appendEvent({
    user_id: state.owner_id,
    session_id: state.session_id,
    event_type: "agent.workflow.updated",
    payload: {
      trigger,
      outcome,
      workflow_status: state.agent_runtime.workflow_status,
      workflow_run_id: state.agent_runtime.workflow_run_id,
      continuation_count: state.agent_runtime.continuation_count,
      current_module_id: state.agent_runtime.current_module_id,
      decision_id: decision?.decision_id,
      decision_action: decision?.action,
      completion_status: state.completion_report?.status,
      completion_coverage_ratio: state.completion_report?.coverage_ratio,
      message: state.agent_runtime.workflow_message
    }
  });
}

function activeModuleTask(state: SessionState, moduleId?: string) {
  return state.hosted_tasks.find(
    (task) =>
      task.task_type === "module_search" &&
      (!moduleId || task.module_id === moduleId) &&
      (task.status === "pending" || task.status === "running")
  );
}

async function executeAdvance(
  sessionId: string,
  userId: string | undefined,
  options: { start?: boolean; trigger: AgentWorkflowTrigger }
): Promise<AgentWorkflowAdvanceResult> {
  let state = await loadSession(sessionId, userId);
  if (!state) throw new Error("session not found");

  if (options.start) {
    const continuingExistingRun =
      state.agent_runtime.auto_continue &&
      (state.agent_runtime.workflow_status === "running" || state.agent_runtime.workflow_status === "waiting_for_tools");
    if (!continuingExistingRun) {
      state.agent_runtime.workflow_run_id = randomUUID();
      state.agent_runtime.continuation_count = 0;
      state.agent_runtime.used_tool_calls = 0;
      invalidateAgentCompletionArtifacts(state);
      state.agent_decisions = state.agent_decisions.filter(
        (decision) =>
          Boolean(decision.consumed_at) ||
          (decision.action !== "search_module" && decision.action !== "retry_module")
      );
    }
    transition(state, {
      status: "running",
      message: continuingExistingRun ? "Agent 工作流已在后台运行" : "Agent 已接管搜索流程，正在选择首个模块",
      autoContinue: true
    });
    await persistSession(state);
  } else if (!state.agent_runtime.auto_continue) {
    return { state, outcome: "no_op" };
  }

  for (let index = 0; index < MAX_NON_TOOL_TRANSITIONS; index += 1) {
    const pending = pendingAgentDecision(state);
    const decision = pending ?? recordAgentDecision(state, await decideNextAgentActionV2(state));
    state.agent_runtime.continuation_count += 1;

    if (decision.action === "search_module" || decision.action === "retry_module") {
      if (!decision.module_id) throw new Error("Agent 搜索决策缺少 module_id");
      await runModuleSearch(state, decision.module_id, {
        keywordOverride: decision.keyword_override
      });
      consumeAgentDecision(state, decision.module_id);
      const queuedTask = activeModuleTask(state, decision.module_id);

      if (queuedTask) {
        transition(state, {
          status: "waiting_for_tools",
          moduleId: decision.module_id,
          message: `已自动排队「${decision.module_name ?? queuedTask.module_name ?? "当前模块"}」，等待本地执行器回填`,
          autoContinue: true
        });
        await persistSession(state);
        await emitWorkflowEvent(state, options.trigger, "queued", decision);
        return { state, decision, outcome: "queued" };
      }

      transition(state, {
        status: "running",
        moduleId: decision.module_id,
        message: `「${decision.module_name ?? "当前模块"}」已同步完成，Agent 正在选择下一步`,
        autoContinue: true
      });
      await persistSession(state);
      continue;
    }

    if (decision.action === "skip_module") {
      transition(state, {
        status: "running",
        moduleId: decision.module_id,
        message: `已跳过「${decision.module_name ?? "当前模块"}」，继续处理后续模块`,
        autoContinue: true
      });
      await persistSession(state);
      continue;
    }

    if (decision.action === "wait_for_tools") {
      const task = activeModuleTask(state);
      transition(state, {
        status: "waiting_for_tools",
        moduleId: task?.module_id,
        message: task
          ? `本地执行器正在处理「${task.module_name ?? "当前模块"}」，完成后服务端会自动继续`
          : "Agent 正在等待工具状态更新",
        autoContinue: true
      });
      await persistSession(state);
      await emitWorkflowEvent(state, options.trigger, "waiting", decision);
      return { state, decision, outcome: "waiting" };
    }

    const completionReport = buildAgentCompletionReport(state, decision);
    const bundleResult = await composePurchaseBundle(state, completionReport.purchase_bundle!);
    appendSessionLlmCalls(state, bundleResult.call);
    completionReport.purchase_bundle = bundleResult.data;
    if (bundleResult.mode === "connected") {
      state.deepseek_status = "connected";
    }
    state.completion_report = completionReport;
    transition(state, {
      status: "completed",
      message: decision.reason || "所有规划模块均已处理完成",
      autoContinue: false
    });
    await persistSession(state);
    await getRuntimeRepository().appendEvent({
      user_id: state.owner_id,
      session_id: state.session_id,
      event_type: "agent.purchase_bundle.composed",
      payload: {
        source: bundleResult.data.source,
        status: bundleResult.data.status,
        selected_product_count: bundleResult.data.items.length,
        estimated_total: bundleResult.data.estimated_total,
        total_budget: bundleResult.data.total_budget,
        critical_selected_count: bundleResult.data.critical_selected_module_ids.length,
        critical_module_count: bundleResult.data.critical_module_ids.length
      }
    });
    await emitWorkflowEvent(state, options.trigger, "completed", decision);
    return { state, decision, outcome: "completed" };
  }

  transition(state, {
    status: "paused",
    message: "Agent 连续状态转换达到安全上限，已暂停并等待人工继续",
    autoContinue: false
  });
  await persistSession(state);
  await emitWorkflowEvent(state, options.trigger, "paused");
  return { state, outcome: "paused" };
}

async function persistWorkflowFailure(
  sessionId: string,
  userId: string | undefined,
  trigger: AgentWorkflowTrigger,
  error: unknown
) {
  const locked = await withWorkflowSessionLock(sessionId, async () => {
    const state = await loadSession(sessionId, userId);
    if (!state) return;
    transition(state, {
      status: "error",
      message: error instanceof Error ? error.message.slice(0, 300) : "Agent 自动推进失败",
      autoContinue: false
    });
    await persistSession(state);
    await emitWorkflowEvent(state, trigger, "paused").catch(() => undefined);
  });

  // Another instance already owns the session and is making forward progress.
  // Its committed transition should win over this stale failure.
  return locked.acquired;
}

export async function advanceAgentWorkflow(
  sessionId: string,
  userId: string | undefined,
  options: { start?: boolean; trigger: AgentWorkflowTrigger }
) {
  const runnerKey = `${userId ?? "anonymous"}:${sessionId}`;
  const existing = activeRunners.get(runnerKey);
  if (existing) return existing;

  const runner = withWorkflowSessionLock(
    sessionId,
    () => executeAdvance(sessionId, userId, options)
  ).then(async (lock) => {
    if (lock.acquired) return lock.value;
    const state = await loadSession(sessionId, userId);
    if (!state) throw new Error("session not found");
    return {
      state,
      outcome: "waiting" as const
    };
  }).catch(async (error) => {
    await persistWorkflowFailure(sessionId, userId, options.trigger, error).catch(() => undefined);
    throw error;
  });
  activeRunners.set(runnerKey, runner);
  try {
    return await runner;
  } finally {
    if (activeRunners.get(runnerKey) === runner) {
      activeRunners.delete(runnerKey);
    }
  }
}

export async function pauseAgentWorkflow(sessionId: string, userId: string | undefined) {
  return withWorkflowSessionTransaction(sessionId, async () => {
    const state = await loadSession(sessionId, userId);
    if (!state) throw new Error("session not found");
    if (state.agent_runtime.workflow_status === "paused" && !state.agent_runtime.auto_continue) {
      return { state, outcome: "paused" as const };
    }

    const activeTask = activeModuleTask(state);
    const running =
      state.agent_runtime.auto_continue ||
      state.agent_runtime.workflow_status === "running" ||
      state.agent_runtime.workflow_status === "waiting_for_tools" ||
      Boolean(activeTask);
    if (!running || state.agent_runtime.workflow_status === "completed") {
      throw new AgentWorkflowControlError("当前没有可暂停的 Agent 搜索流程。", "workflow_not_running");
    }

    transition(state, {
      status: "paused",
      moduleId: activeTask?.module_id ?? state.agent_runtime.current_module_id,
      message: activeTask
        ? `已按用户要求暂停自动推进；「${activeTask.module_name ?? "当前模块"}」完成后不会继续下一个模块`
        : "已按用户要求暂停 Agent 搜索，可随时从当前进度继续",
      autoContinue: false
    });
    await persistSession(state);
    await emitWorkflowEvent(state, "user_pause", "paused");
    return { state, outcome: "paused" as const };
  });
}

export async function resumeAgentWorkflow(sessionId: string, userId: string | undefined) {
  const prepared = await withWorkflowSessionTransaction(sessionId, async () => {
    const state = await loadSession(sessionId, userId);
    if (!state) throw new Error("session not found");
    if (state.agent_runtime.workflow_status !== "paused" || state.agent_runtime.auto_continue) {
      throw new AgentWorkflowControlError("当前 Agent 搜索流程不处于暂停状态。", "workflow_not_paused");
    }

    const activeTask = activeModuleTask(state);
    transition(state, {
      status: activeTask ? "waiting_for_tools" : "running",
      moduleId: activeTask?.module_id ?? state.agent_runtime.current_module_id,
      message: activeTask
        ? `已恢复自动推进，等待「${activeTask.module_name ?? "当前模块"}」完成后继续`
        : "已从原进度恢复，Agent 正在选择下一个未完成模块",
      autoContinue: true
    });
    await persistSession(state);
    if (activeTask) {
      await emitWorkflowEvent(state, "user_resume", "waiting");
    }
    return { state, activeTask: Boolean(activeTask) };
  });

  if (prepared.activeTask) {
    return { state: prepared.state, outcome: "waiting" as const };
  }
  return advanceAgentWorkflow(sessionId, userId, { trigger: "user_resume" });
}

export async function recoverAgentCompletionGaps(
  sessionId: string,
  userId: string | undefined
) {
  const preparation = await withWorkflowSessionLock(sessionId, async () => {
    const state = await loadSession(sessionId, userId);
    if (!state) throw new Error("session not found");
    if (
      state.agent_runtime.auto_continue ||
      state.agent_runtime.workflow_status === "running" ||
      state.agent_runtime.workflow_status === "waiting_for_tools" ||
      state.hosted_tasks.some((task) =>
        task.task_type === "module_search" && (task.status === "pending" || task.status === "running")
      )
    ) {
      throw new AgentCompletionRecoveryError("Agent 仍在执行当前搜索，请等待本轮结束后再补齐缺口。");
    }

    const report = state.completion_report;
    if (!report) {
      throw new AgentCompletionRecoveryError("当前会话还没有可恢复的 Agent 完成报告。");
    }

    const plannedModuleIds = new Set(state.shopping_plan.modules.map((module) => module.module_id));
    const moduleIds = report.uncovered_module_ids.filter(
      (moduleId) =>
        plannedModuleIds.has(moduleId) &&
        (state.module_candidates[moduleId]?.length ?? 0) === 0
    );
    if (moduleIds.length === 0) {
      throw new AgentCompletionRecoveryError("当前规划没有未覆盖模块，无需重新启动搜索。");
    }

    for (const moduleId of moduleIds) {
      removeModuleAgentDecisions(state, moduleId);
      delete state.module_candidates[moduleId];
      delete state.module_reviews[moduleId];
      delete state.module_search_traces[moduleId];
    }
    invalidateAgentCompletionArtifacts(state);
    transition(state, {
      status: "idle",
      message: `用户已确认补齐 ${moduleIds.length} 个未覆盖模块，等待 Agent 重新执行`,
      autoContinue: false
    });
    await persistSession(state);
    await getRuntimeRepository().appendEvent({
      user_id: state.owner_id,
      session_id: state.session_id,
      event_type: "agent.completion.recovery_confirmed",
      payload: {
        module_ids: moduleIds,
        preserved_module_count: state.shopping_plan.modules.length - moduleIds.length
      }
    });
    return { moduleIds };
  });

  if (!preparation.acquired) {
    throw new AgentCompletionRecoveryError("当前会话正在被另一个 Agent 进程更新，请稍后重试。");
  }

  const advance = await advanceAgentWorkflow(sessionId, userId, {
    start: true,
    trigger: "user_recover_gaps"
  });
  return {
    ...advance,
    recovered_module_ids: preparation.value.moduleIds
  };
}

function normalizeSearchKeyword(keyword: string | undefined) {
  return keyword?.replace(/\s+/g, " ").trim() ?? "";
}

function nextQualityKeyword(state: SessionState, moduleId: string) {
  const module = state.shopping_plan.modules.find((item) => item.module_id === moduleId);
  if (!module) return "";
  const trace = state.module_search_traces[moduleId];
  const searched = new Set((trace?.searched_keywords ?? []).map(normalizeSearchKeyword));
  const primary = normalizeSearchKeyword(
    module.search_strategy?.primary_keyword || module.search_keyword || module.module_name
  );
  const proposals = [
    state.module_reviews[moduleId]?.suggested_keyword,
    ...(module.search_strategy?.alternate_keywords ?? []),
    `${primary} ${(module.search_strategy?.must_have_signals ?? []).slice(0, 2).join(" ")}`,
    ...["官方旗舰", "高销量口碑", "预算内适配", "规格明确"].map((suffix) => `${primary} ${suffix}`)
  ].map(normalizeSearchKeyword).filter(Boolean);

  return proposals.find((keyword) => !searched.has(keyword)) ?? "";
}

export async function improveAgentCompletionQuality(
  sessionId: string,
  userId: string | undefined
) {
  const preparation = await withWorkflowSessionLock(sessionId, async () => {
    const state = await loadSession(sessionId, userId);
    if (!state) throw new Error("session not found");
    if (
      state.agent_runtime.auto_continue ||
      state.agent_runtime.workflow_status === "running" ||
      state.agent_runtime.workflow_status === "waiting_for_tools" ||
      state.hosted_tasks.some((task) =>
        task.task_type === "module_search" && (task.status === "pending" || task.status === "running")
      )
    ) {
      throw new AgentCompletionRecoveryError("Agent 仍在执行当前搜索，请等待本轮结束后再优化候选池。");
    }

    const report = state.completion_report;
    if (!report) {
      throw new AgentCompletionRecoveryError("当前会话还没有可优化的 Agent 完成报告。");
    }

    const targets = report.thin_module_ids
      .map((moduleId) => ({ moduleId, keyword: nextQualityKeyword(state, moduleId) }))
      .filter(({ moduleId, keyword }) =>
        Boolean(keyword) && (state.module_candidates[moduleId]?.length ?? 0) > 0
      );
    if (targets.length === 0) {
      throw new AgentCompletionRecoveryError("当前没有可使用新关键词继续优化的薄弱候选池。");
    }

    for (const target of targets) {
      const review = state.module_reviews[target.moduleId];
      if (review) {
        review.status = "thin";
        review.suggested_keyword = target.keyword;
        review.user_confirmed_retry = true;
        review.next_action = `用户已确认使用“${target.keyword}”增量补搜，并保留当前候选。`;
      }
    }
    invalidateAgentCompletionArtifacts(state);
    transition(state, {
      status: "idle",
      message: `用户已确认优化 ${targets.length} 个薄弱候选池，等待 Agent 增量补搜`,
      autoContinue: false
    });
    await persistSession(state);
    await getRuntimeRepository().appendEvent({
      user_id: state.owner_id,
      session_id: state.session_id,
      event_type: "agent.completion.quality_improvement_confirmed",
      payload: {
        module_ids: targets.map((target) => target.moduleId),
        keywords: Object.fromEntries(targets.map((target) => [target.moduleId, target.keyword])),
        preserved_candidate_count: targets.reduce(
          (count, target) => count + (state.module_candidates[target.moduleId]?.length ?? 0),
          0
        )
      }
    });
    return { targets };
  });

  if (!preparation.acquired) {
    throw new AgentCompletionRecoveryError("当前会话正在被另一个 Agent 进程更新，请稍后重试。");
  }

  const advance = await advanceAgentWorkflow(sessionId, userId, {
    start: true,
    trigger: "user_improve_quality"
  });
  return {
    ...advance,
    targeted_module_ids: preparation.value.targets.map((target) => target.moduleId)
  };
}
