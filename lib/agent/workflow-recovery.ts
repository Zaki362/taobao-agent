import { advanceAgentWorkflow } from "@/lib/agent/workflow-runner";
import { getRuntimeRepository } from "@/lib/runtime";
import { reconcileCompletedRuntimeJob, reconcileTerminalRuntimeJob } from "@/lib/runtime/jobs";
import type { ExecutorDevice } from "@/lib/runtime/types";
import type { SessionState } from "@/lib/session/types";

export interface WorkflowRecoveryResult {
  recovered: boolean;
  session_id?: string;
  reason?: "completed_result" | "terminal_state" | "missing_continuation" | "recovery_failed";
  error_message?: string;
}

export interface WorkflowRecoveryScanResult {
  scanned: number;
  recovered: number;
  items: WorkflowRecoveryResult[];
}

async function recoverSession(state: SessionState): Promise<WorkflowRecoveryResult> {
  const repository = getRuntimeRepository();
  const activeTask = state.hosted_tasks.find((task) =>
    task.task_type === "module_search" &&
    (task.status === "pending" || task.status === "running")
  );

  if (activeTask?.runtime_job_id) {
    const job = await repository.getJob(activeTask.runtime_job_id);
    if (!job || job.status === "pending" || job.status === "leased" || job.status === "running") {
      return { recovered: false, session_id: state.session_id };
    }
    if (job.status === "completed") {
      await reconcileCompletedRuntimeJob(job.id);
      await advanceAgentWorkflow(state.session_id, state.owner_id, { trigger: "recovery" });
      return { recovered: true, session_id: state.session_id, reason: "completed_result" };
    }
    if (job.status === "failed" || job.status === "cancelled") {
      await reconcileTerminalRuntimeJob(job.id);
      if (job.status === "failed") {
        await advanceAgentWorkflow(state.session_id, state.owner_id, { trigger: "recovery" });
      }
      return { recovered: true, session_id: state.session_id, reason: "terminal_state" };
    }
    return { recovered: false, session_id: state.session_id };
  }

  if (activeTask) {
    return { recovered: false, session_id: state.session_id };
  }

  const workflowRunId = state.agent_runtime.workflow_run_id;
  if (workflowRunId) {
    const orphanedTerminalJob = (await repository.listJobs(state.session_id, state.owner_id)).find((job) =>
      job.job_type === "module_search" &&
      job.idempotency_key.endsWith(`:${workflowRunId}`) &&
      (job.status === "completed" || job.status === "failed" || job.status === "cancelled") &&
      !state.hosted_tasks.some((task) => task.runtime_job_id === job.id)
    );

    if (orphanedTerminalJob?.status === "completed") {
      await reconcileCompletedRuntimeJob(orphanedTerminalJob.id);
      await advanceAgentWorkflow(state.session_id, state.owner_id, { trigger: "recovery" });
      return { recovered: true, session_id: state.session_id, reason: "completed_result" };
    }
    if (orphanedTerminalJob) {
      await reconcileTerminalRuntimeJob(orphanedTerminalJob.id);
      if (orphanedTerminalJob.status === "failed") {
        await advanceAgentWorkflow(state.session_id, state.owner_id, { trigger: "recovery" });
      }
      return { recovered: true, session_id: state.session_id, reason: "terminal_state" };
    }
  }

  await advanceAgentWorkflow(state.session_id, state.owner_id, { trigger: "recovery" });
  return { recovered: true, session_id: state.session_id, reason: "missing_continuation" };
}

export async function recoverAgentWorkflows(
  options: { userId?: string; limit?: number; maxRecoveries?: number } = {}
): Promise<WorkflowRecoveryScanResult> {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 25);
  const maxRecoveries = Math.min(Math.max(options.maxRecoveries ?? limit, 1), limit);
  const sessions = await getRuntimeRepository().listWorkflowRecoveryCandidates(options.userId, limit);
  const items: WorkflowRecoveryResult[] = [];
  let recovered = 0;

  for (const state of sessions) {
    let item: WorkflowRecoveryResult;
    try {
      item = await recoverSession(state);
    } catch (error) {
      item = {
        recovered: false,
        session_id: state.session_id,
        reason: "recovery_failed",
        error_message: (error instanceof Error ? error.message : "workflow recovery failed").slice(0, 300)
      };
    }
    items.push(item);
    if (item.recovered) recovered += 1;
    if (recovered >= maxRecoveries) break;
  }

  return {
    scanned: items.length,
    recovered,
    items
  };
}

export async function recoverAgentWorkflowForExecutor(
  device: ExecutorDevice
): Promise<WorkflowRecoveryResult> {
  if (!device.capabilities.includes("module_search")) return { recovered: false };
  const result = await recoverAgentWorkflows({
    userId: device.user_id,
    limit: 25,
    maxRecoveries: 1
  });
  return result.items.find((item) => item.recovered) ?? { recovered: false };
}
