import { randomUUID } from "node:crypto";
import {
  consumeAgentDecision,
  createAgentDecision,
  isTaskFromCurrentWorkflowRun,
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
import {
  isExecutorAuthenticationError,
  releaseAuthenticationFailureHoldForUser
} from "@/lib/runtime/jobs";
import { isExecutorDeviceOnline } from "@/lib/runtime/executor-status";
import { EXECUTOR_STARTUP_STANDBY_MESSAGE } from "@/lib/runtime/startup-standby";
import type { ExecutorDevice } from "@/lib/runtime/types";
import type { AgentDecision, SessionState } from "@/lib/session/types";

export type AgentWorkflowTrigger =
  | "user_start"
  | "user_pause"
  | "user_resume"
  | "user_accept_partial_results"
  | "user_recover_gaps"
  | "user_improve_quality"
  | "executor_startup_standby"
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
    public readonly code:
      | "workflow_not_running"
      | "workflow_not_paused"
      | "authentication_retry_not_available"
  ) {
    super(message);
    this.name = "AgentWorkflowControlError";
  }
}

export class AgentPartialResultsAcceptanceError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "workflow_not_authentication_paused"
      | "partial_results_unavailable"
      | "partial_results_search_active"
  ) {
    super(message);
    this.name = "AgentPartialResultsAcceptanceError";
  }
}

declare global {
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

function currentWorkflowModuleSearchTasks(state: SessionState) {
  const moduleId = state.agent_runtime.current_module_id;
  if (!moduleId) return [];
  const workflowRunId = state.agent_runtime.workflow_run_id;
  return state.hosted_tasks.filter(
    (task) => {
      const taskWorkflowRunId = typeof task.payload.workflow_run_id === "string"
        ? task.payload.workflow_run_id
        : undefined;
      return (
        task.task_type === "module_search" &&
        task.module_id === moduleId &&
        (workflowRunId
          ? taskWorkflowRunId === workflowRunId
          : isTaskFromCurrentWorkflowRun(state, task))
      );
    }
  );
}

function hasCurrentModuleAuthenticationFailure(state: SessionState) {
  const moduleId = state.agent_runtime.current_module_id;
  if (!moduleId) return false;
  if (isExecutorAuthenticationError(state.agent_runtime.workflow_message)) return true;
  if (currentWorkflowModuleSearchTasks(state).some(
    (task) => task.status === "failed" && isExecutorAuthenticationError(task.error_message ?? "")
  )) {
    return true;
  }
  return state.module_search_traces[moduleId]?.attempts.some(
    (attempt) =>
      attempt.status === "error" &&
      isExecutorAuthenticationError(attempt.error_message ?? "")
  ) === true;
}

async function executeAdvance(
  sessionId: string,
  userId: string | undefined,
  options: { start?: boolean; trigger: AgentWorkflowTrigger }
): Promise<AgentWorkflowAdvanceResult> {
  const state = await loadSession(sessionId, userId);
  if (!state) throw new Error("session not found");
  if (state.archived_at) {
    return { state, outcome: "paused" };
  }

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

export async function establishExecutorStartupStandby(device: ExecutorDevice) {
  const repository = getRuntimeRepository();
  const anotherExecutorIsOnline = (await repository.listDevices(device.user_id)).some(
    (candidate) =>
      candidate.id !== device.id &&
      candidate.capabilities.includes("module_search") &&
      isExecutorDeviceOnline(candidate)
  );
  if (anotherExecutorIsOnline) {
    return {
      paused_workflows: 0,
      paused_session_ids: [] as string[],
      skipped_reason: "another_executor_online" as const
    };
  }

  const pausedSessionIds: string[] = [];
  const sessions = await repository.listSessions(device.user_id);
  const recoveryCandidateIds = new Set(
    (await repository.listWorkflowRecoveryCandidates(device.user_id, 100))
      .map((state) => state.session_id)
  );
  for (const snapshot of sessions) {
    if (
      snapshot.archived_at ||
      !snapshot.agent_runtime.auto_continue ||
      (
        snapshot.agent_runtime.workflow_status !== "running" &&
        snapshot.agent_runtime.workflow_status !== "waiting_for_tools"
      )
    ) {
      continue;
    }
    const workflowRunId = snapshot.agent_runtime.workflow_run_id;
    const hasCurrentRuntimeJob = Boolean(workflowRunId) &&
      (await repository.listJobs(snapshot.session_id, device.user_id)).some((job) =>
        (job.job_type === "module_search" || job.job_type === "product_detail") &&
        job.payload.workflow_run_id === workflowRunId &&
        (job.status === "pending" || job.status === "leased" || job.status === "running")
      );
    if (!hasCurrentRuntimeJob && !recoveryCandidateIds.has(snapshot.session_id)) continue;

    const paused = await withWorkflowSessionTransaction(snapshot.session_id, async () => {
      const state = await loadSession(snapshot.session_id, device.user_id);
      if (
        !state ||
        state.archived_at ||
        !state.agent_runtime.auto_continue ||
        (
          state.agent_runtime.workflow_status !== "running" &&
          state.agent_runtime.workflow_status !== "waiting_for_tools"
        )
      ) {
        return false;
      }

      const activeTask = activeModuleTask(state);
      transition(state, {
        status: "paused",
        moduleId: activeTask?.module_id ?? state.agent_runtime.current_module_id,
        message: EXECUTOR_STARTUP_STANDBY_MESSAGE,
        autoContinue: false
      });
      await persistSession(state);
      await emitWorkflowEvent(state, "executor_startup_standby", "paused");
      return true;
    });
    if (paused) pausedSessionIds.push(snapshot.session_id);
  }

  return {
    paused_workflows: pausedSessionIds.length,
    paused_session_ids: pausedSessionIds
  };
}

export async function resumeAgentWorkflow(
  sessionId: string,
  userId: string | undefined,
  options: { retryAuthenticationFailure?: boolean } = {}
) {
  const prepared = await withWorkflowSessionTransaction(sessionId, async () => {
    const state = await loadSession(sessionId, userId);
    if (!state) throw new Error("session not found");
    if (state.agent_runtime.workflow_status !== "paused" || state.agent_runtime.auto_continue) {
      throw new AgentWorkflowControlError("当前 Agent 搜索流程不处于暂停状态。", "workflow_not_paused");
    }

    let activeTask = activeModuleTask(state);
    if (options.retryAuthenticationFailure) {
      const moduleId = state.agent_runtime.current_module_id;
      const currentTasks = currentWorkflowModuleSearchTasks(state);
      const alreadyQueuedTask = currentTasks.find(
        (task) => task.status === "pending" || task.status === "running"
      );
      const failedAuthenticationTasks = currentTasks.filter(
        (task) =>
          task.status === "failed" &&
          isExecutorAuthenticationError(task.error_message ?? "")
      );
      let failedAuthenticationTask = failedAuthenticationTasks[0];
      for (const task of failedAuthenticationTasks) {
        if (
          task.runtime_job_id &&
          await getRuntimeRepository().getActiveAuthenticationFailureHold(task.runtime_job_id)
        ) {
          failedAuthenticationTask = task;
          break;
        }
      }
      const completedRetryTask = currentTasks.find((task) => task.status === "completed");

      if (
        !moduleId ||
        !hasCurrentModuleAuthenticationFailure(state) ||
        (!alreadyQueuedTask && !failedAuthenticationTask && !completedRetryTask)
      ) {
        throw new AgentWorkflowControlError(
          "当前暂停流程没有可恢复的淘宝登录失败搜索。请刷新进度后重试。",
          "authentication_retry_not_available"
        );
      }

      if (alreadyQueuedTask) {
        activeTask = alreadyQueuedTask;
      } else if (failedAuthenticationTask) {
        const keyword = typeof failedAuthenticationTask.payload.keyword === "string"
          ? failedAuthenticationTask.payload.keyword
          : undefined;
        if (!keyword) {
          throw new AgentWorkflowControlError(
            "淘宝登录失败任务缺少原搜索关键词，无法安全恢复。",
            "authentication_retry_not_available"
          );
        }
        if (failedAuthenticationTask.runtime_job_id) {
          const activeHold = await getRuntimeRepository().getActiveAuthenticationFailureHold(
            failedAuthenticationTask.runtime_job_id
          );
          const released = await releaseAuthenticationFailureHoldForUser(
            failedAuthenticationTask.runtime_job_id,
            userId,
            "user_retry"
          );
          if (
            activeHold &&
            !released &&
            await getRuntimeRepository().getActiveAuthenticationFailureHold(
              failedAuthenticationTask.runtime_job_id
            )
          ) {
            throw new AgentWorkflowControlError(
              "登录失败任务仍在安全暂停中，请刷新后重试。",
              "authentication_retry_not_available"
            );
          }
        }
        await runModuleSearch(state, moduleId, {
          keywordOverride: keyword,
          confirmedRetry: true
        });
        const revivedTask = state.hosted_tasks.find(
          (task) => task.task_id === failedAuthenticationTask.task_id
        );
        activeTask = revivedTask?.status === "pending" || revivedTask?.status === "running"
          ? revivedTask
          : undefined;
      } else {
        // A retry issued by an older client may have completed while the workflow
        // was still paused. Resume advancement without enqueueing another search.
        activeTask = undefined;
      }
    }

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

export async function acceptPartialAgentResults(
  sessionId: string,
  userId: string | undefined
) {
  return withWorkflowSessionTransaction(sessionId, async () => {
    const state = await loadSession(sessionId, userId);
    if (!state) throw new Error("session not found");

    const moduleId = state.agent_runtime.current_module_id;
    const currentTasks = currentWorkflowModuleSearchTasks(state);
    if (
      state.agent_runtime.workflow_status !== "paused" ||
      state.agent_runtime.auto_continue ||
      !moduleId ||
      !hasCurrentModuleAuthenticationFailure(state) ||
      currentTasks.length === 0
    ) {
      throw new AgentPartialResultsAcceptanceError(
        "当前流程不是由淘宝登录失效导致的搜索暂停，不能接受部分结果。",
        "workflow_not_authentication_paused"
      );
    }

    const candidateCount = Object.values(state.module_candidates)
      .reduce((total, candidates) => total + candidates.length, 0);
    if (candidateCount === 0) {
      throw new AgentPartialResultsAcceptanceError(
        "当前还没有已保存候选，无法直接进入选购。",
        "partial_results_unavailable"
      );
    }

    const authenticationFailedTasks = currentTasks.filter(
      (task) =>
        task.status === "failed" &&
        isExecutorAuthenticationError(task.error_message ?? "")
    );
    let heldAuthenticationTask = authenticationFailedTasks[0];
    for (const task of authenticationFailedTasks) {
      if (
        task.runtime_job_id &&
        await getRuntimeRepository().getActiveAuthenticationFailureHold(task.runtime_job_id)
      ) {
        heldAuthenticationTask = task;
        break;
      }
    }
    const failedTask = heldAuthenticationTask ?? currentTasks.find((task) => task.status === "failed");
    const completedTask = currentTasks.find((task) => task.status === "completed");
    const activeTask = currentTasks.find(
      (task) => task.status === "pending" || task.status === "running"
    );
    const resolutionTask = failedTask ?? completedTask ?? activeTask;
    if (!resolutionTask) {
      throw new AgentPartialResultsAcceptanceError(
        "没有找到当前登录失败模块的搜索记录，无法安全接受部分结果。",
        "workflow_not_authentication_paused"
      );
    }

    const otherActiveTask = state.hosted_tasks.find(
      (task) =>
        task.task_type === "module_search" &&
        task.task_id !== resolutionTask.task_id &&
        (task.status === "pending" || task.status === "running")
    );
    if (otherActiveTask) {
      throw new AgentPartialResultsAcceptanceError(
        "仍有其他真实搜索正在执行，请等待其结束后再接受部分结果。",
        "partial_results_search_active"
      );
    }

    if (activeTask) {
      if (activeTask.status === "running" || !activeTask.runtime_job_id) {
        throw new AgentPartialResultsAcceptanceError(
          "当前真实搜索已被执行器领取，暂时不能切换为部分结果。",
          "partial_results_search_active"
        );
      }
      const cancelledJob = await getRuntimeRepository().cancelJob(activeTask.runtime_job_id, userId);
      if (!cancelledJob) {
        throw new AgentPartialResultsAcceptanceError(
          "当前真实搜索已开始执行，暂时不能切换为部分结果。",
          "partial_results_search_active"
        );
      }
      activeTask.status = "cancelled";
      activeTask.error_message = "用户选择接受已有部分结果，已取消待执行的登录恢复搜索";
      activeTask.updated_at = new Date().toISOString();
      await getRuntimeRepository().appendEvent({
        user_id: state.owner_id,
        session_id: state.session_id,
        job_id: cancelledJob.id,
        event_type: "job.cancelled",
        payload: {
          job_type: cancelledJob.job_type,
          reason: "partial_results_accepted"
        }
      });
    }

    if (resolutionTask.runtime_job_id) {
      const activeHold = await getRuntimeRepository().getActiveAuthenticationFailureHold(
        resolutionTask.runtime_job_id
      );
      const released = await releaseAuthenticationFailureHoldForUser(
        resolutionTask.runtime_job_id,
        userId,
        "partial_results_accepted"
      );
      if (
        activeHold &&
        !released &&
        await getRuntimeRepository().getActiveAuthenticationFailureHold(
          resolutionTask.runtime_job_id
        )
      ) {
        throw new AgentPartialResultsAcceptanceError(
          "登录失败任务仍在安全暂停中，请刷新后重试。",
          "workflow_not_authentication_paused"
        );
      }
    }

    const acceptedAt = new Date().toISOString();
    resolutionTask.payload = {
      ...resolutionTask.payload,
      user_resolution: "user_skipped",
      partial_results_status: "partial_results_accepted",
      partial_results_accepted_at: acceptedAt
    };
    resolutionTask.updated_at = acceptedAt;

    const module = state.shopping_plan.modules.find((item) => item.module_id === moduleId);
    const skipDecision = recordAgentDecision(state, createAgentDecision({
      action: "skip_module",
      source: "policy_fallback",
      confidence: "high",
      module_id: moduleId,
      module_name: module?.module_name ?? resolutionTask.module_name,
      reason: `用户已明确选择使用已有部分结果进入选购，不再自动搜索「${module?.module_name ?? resolutionTask.module_name ?? "当前模块"}」。`,
      evidence: [
        resolutionTask.error_message ?? state.agent_runtime.workflow_message,
        `已保留 ${candidateCount} 个登录失效前回填的候选`
      ],
      expected_gain: "立即使用已保存候选进入选购，避免登录恢复成为强制前置条件",
      tool_cost: 0,
      guardrail_notes: ["user_skipped", "partial_results_accepted"],
      consumed_at: acceptedAt
    }));

    invalidateAgentCompletionArtifacts(state);
    state.completion_report = buildAgentCompletionReport(state, skipDecision);
    transition(state, {
      status: "completed",
      message: "已按你的选择使用已有部分结果进入选购；未完成模块不会自动重新搜索。",
      autoContinue: false
    });
    await persistSession(state);
    await getRuntimeRepository().appendEvent({
      user_id: state.owner_id,
      session_id: state.session_id,
      job_id: resolutionTask.runtime_job_id,
      event_type: "agent.partial_results.accepted",
      payload: {
        module_id: moduleId,
        module_name: module?.module_name ?? resolutionTask.module_name,
        task_id: resolutionTask.task_id,
        workflow_run_id: state.agent_runtime.workflow_run_id,
        user_resolution: "user_skipped",
        status: "partial_results_accepted",
        preserved_candidate_count: candidateCount,
        covered_module_count: state.completion_report.covered_module_ids.length,
        total_module_count: state.shopping_plan.modules.length,
        completion_status: state.completion_report.status
      }
    });
    await emitWorkflowEvent(state, "user_accept_partial_results", "completed", skipDecision);
    return {
      state,
      skippedModuleId: moduleId,
      taskId: resolutionTask.task_id,
      preservedCandidateCount: candidateCount
    };
  });
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

    const recoveryConfirmedAt = new Date().toISOString();
    const completedWorkflowRunId =
      report.workflow_run_id ||
      state.agent_runtime.workflow_run_id ||
      `legacy:${report.generated_at}`;
    const supersededTaskIds: string[] = [];
    for (const moduleId of moduleIds) {
      for (const task of state.hosted_tasks) {
        if (
          task.task_type !== "module_search" ||
          task.module_id !== moduleId ||
          (task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled")
        ) {
          continue;
        }
        task.payload = {
          ...task.payload,
          workflow_run_id: typeof task.payload.workflow_run_id === "string"
            ? task.payload.workflow_run_id
            : completedWorkflowRunId,
          recovery_superseded_at: recoveryConfirmedAt,
          recovery_superseded_reason: "user_confirmed_gap_recovery"
        };
        task.updated_at = recoveryConfirmedAt;
        supersededTaskIds.push(task.task_id);
      }
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
        preserved_module_count: state.shopping_plan.modules.length - moduleIds.length,
        previous_workflow_run_id: completedWorkflowRunId,
        superseded_task_ids: supersededTaskIds
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
