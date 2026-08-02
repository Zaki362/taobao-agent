import { getRuntimeRepository } from "@/lib/runtime";
import { withWorkflowSessionTransaction } from "@/lib/runtime/database";
import { persistSession } from "@/lib/session/repository";
import type { RuntimeJob } from "@/lib/runtime/types";
import type { SessionState } from "@/lib/session/types";

export type ShoppingSessionLifecycleAction = "archive" | "restore";

export interface ShoppingSessionLifecycleResult {
  action: ShoppingSessionLifecycleAction;
  state: SessionState;
  cancelled_pending_jobs: number;
  active_jobs_remaining: number;
}

export class ShoppingSessionLifecycleError extends Error {
  constructor(message: string, public readonly code: "session_not_found") {
    super(message);
    this.name = "ShoppingSessionLifecycleError";
  }
}

function isActiveJob(job: RuntimeJob) {
  return job.status === "leased" || job.status === "running";
}

function markCancelledHostedTasks(state: SessionState, cancelledJobIds: Set<string>, now: string) {
  for (const task of state.hosted_tasks) {
    if (task.status !== "pending") continue;
    const runtimeJobId = task.runtime_job_id ?? task.task_id;
    const hasRuntimeJob = Boolean(task.runtime_job_id);
    if (hasRuntimeJob && !cancelledJobIds.has(runtimeJobId)) continue;

    task.status = "cancelled";
    task.error_message = "购物任务已归档，尚未执行的工具调用已取消";
    task.updated_at = now;
  }
}

async function archiveShoppingSessionLocked(
  state: SessionState,
  userId: string | undefined
): Promise<ShoppingSessionLifecycleResult> {
  const repository = getRuntimeRepository();
  if (state.archived_at) {
    const jobs = await repository.listJobs(state.session_id, userId);
    return {
      action: "archive",
      state,
      cancelled_pending_jobs: 0,
      active_jobs_remaining: jobs.filter(isActiveJob).length
    };
  }

  const now = new Date().toISOString();
  const jobsBefore = await repository.listJobs(state.session_id, userId);
  const cancelledJobIds = new Set<string>();

  for (const job of jobsBefore) {
    if (job.status !== "pending") continue;
    const cancelled = await repository.cancelJob(job.id, userId);
    if (cancelled) cancelledJobIds.add(cancelled.id);
  }

  markCancelledHostedTasks(state, cancelledJobIds, now);
  const jobsAfter = await repository.listJobs(state.session_id, userId);
  const activeJobs = jobsAfter.filter(isActiveJob);

  state.archived_at = now;
  state.archived_from_workflow_status = state.agent_runtime.workflow_status;
  state.agent_runtime.auto_continue = false;
  if (
    state.agent_runtime.workflow_status === "running" ||
    state.agent_runtime.workflow_status === "waiting_for_tools" ||
    state.agent_runtime.workflow_status === "error"
  ) {
    state.agent_runtime.workflow_status = "paused";
  }
  state.agent_runtime.workflow_message = activeJobs.length > 0
    ? `任务已归档；${activeJobs.length} 个已被执行器领取的动作可能完成，但不会继续后续模块`
    : "任务已归档；自动推进和尚未领取的工具调用均已停止";
  state.agent_runtime.last_transition_at = now;
  state.last_action = "归档购物任务";

  await persistSession(state);
  await repository.appendEvent({
    user_id: state.owner_id,
    session_id: state.session_id,
    event_type: "session.archived",
    payload: {
      cancelled_pending_jobs: cancelledJobIds.size,
      active_jobs_remaining: activeJobs.length
    }
  });

  return {
    action: "archive",
    state,
    cancelled_pending_jobs: cancelledJobIds.size,
    active_jobs_remaining: activeJobs.length
  };
}

async function restoreShoppingSessionLocked(state: SessionState): Promise<ShoppingSessionLifecycleResult> {
  const repository = getRuntimeRepository();
  if (!state.archived_at) {
    return {
      action: "restore",
      state,
      cancelled_pending_jobs: 0,
      active_jobs_remaining: 0
    };
  }

  const now = new Date().toISOString();
  const previousStatus = state.archived_from_workflow_status;
  state.archived_at = undefined;
  state.archived_from_workflow_status = undefined;
  state.agent_runtime.auto_continue = false;
  if (previousStatus === "completed" || state.agent_runtime.workflow_status === "completed") {
    state.agent_runtime.workflow_status = "completed";
    state.agent_runtime.workflow_message = "任务已恢复，可以继续查看已有推荐结果";
  } else if (previousStatus === "idle") {
    state.agent_runtime.workflow_status = "idle";
    state.agent_runtime.workflow_message = "任务已恢复，请确认当前购物规划后再开始搜索";
  } else {
    state.agent_runtime.workflow_status = "paused";
    state.agent_runtime.workflow_message = "任务已恢复到购物任务列表；请确认当前规划后再继续 Agent 搜索";
  }
  state.agent_runtime.last_transition_at = now;
  state.last_action = "恢复已归档购物任务";

  await persistSession(state);
  await repository.appendEvent({
    user_id: state.owner_id,
    session_id: state.session_id,
    event_type: "session.restored",
    payload: { automatic_resume: false }
  });

  const jobs = await repository.listJobs(state.session_id, state.owner_id);

  return {
    action: "restore",
    state,
    cancelled_pending_jobs: 0,
    active_jobs_remaining: jobs.filter(isActiveJob).length
  };
}

export async function updateShoppingSessionLifecycle(
  sessionId: string,
  action: ShoppingSessionLifecycleAction,
  userId: string | undefined
) {
  return withWorkflowSessionTransaction(sessionId, async () => {
    const repository = getRuntimeRepository();
    const state = await repository.getSession(sessionId, userId);
    if (!state) throw new ShoppingSessionLifecycleError("购物任务不存在或无权访问。", "session_not_found");

    return action === "archive"
      ? archiveShoppingSessionLocked(state, userId)
      : restoreShoppingSessionLocked(state);
  });
}
