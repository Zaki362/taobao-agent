import { randomUUID } from "node:crypto";
import {
  consumeAgentDecision,
  pendingAgentDecision,
  recordAgentDecision
} from "@/lib/agent/decision-engine";
import { buildAgentCompletionReport } from "@/lib/agent/completion-review";
import { runModuleSearch } from "@/lib/agent/product-matcher";
import { decideNextAgentActionV2 } from "@/lib/agent/runtime-v2";
import { getRuntimeRepository } from "@/lib/runtime";
import { withWorkflowSessionLock } from "@/lib/runtime/database";
import { loadSession, persistSession } from "@/lib/session/repository";
import type { AgentDecision, SessionState } from "@/lib/session/types";

export type AgentWorkflowTrigger =
  | "user_start"
  | "job_completed"
  | "job_failed"
  | "legacy_task_resolved"
  | "recovery";

export interface AgentWorkflowAdvanceResult {
  state: SessionState;
  decision?: AgentDecision;
  outcome: "queued" | "waiting" | "completed" | "paused" | "no_op";
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
      state.completion_report = undefined;
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

    state.completion_report = buildAgentCompletionReport(state, decision);
    transition(state, {
      status: "completed",
      message: decision.reason || "所有规划模块均已处理完成",
      autoContinue: false
    });
    await persistSession(state);
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
