import { advanceAgentWorkflow } from "@/lib/agent/workflow-runner";
import { getRuntimeRepository } from "@/lib/runtime";
import {
  isCurrentPreferredProductDetailJob,
  reconcileCompletedRuntimeJob,
  reconcileTerminalRuntimeJob
} from "@/lib/runtime/jobs";
import type { ExecutorDevice } from "@/lib/runtime/types";
import type { SessionState } from "@/lib/session/types";

export interface WorkflowRecoveryResult {
  recovered: boolean;
  session_id?: string;
  reason?: "completed_result" | "terminal_state" | "missing_continuation" | "recovery_failed" | "authentication_required" | "mcp_unavailable";
  error_message?: string;
}

export interface WorkflowRecoveryScanResult {
  scanned: number;
  recovered: number;
  items: WorkflowRecoveryResult[];
}

async function hasDeferredProductDetail(
  sessionId: string,
  userId: string | undefined,
  searchJobId: string
) {
  const repository = getRuntimeRepository();
  const state = await repository.getSession(sessionId, userId);
  if (!state) return false;
  return (await repository.listJobs(sessionId, userId)).some((job) =>
    job.job_type === "product_detail" &&
    job.payload.search_job_id === searchJobId &&
    isCurrentPreferredProductDetailJob(state, job) &&
    (job.status === "pending" || job.status === "leased" || job.status === "running")
  );
}

async function recoverSession(state: SessionState): Promise<WorkflowRecoveryResult> {
  const repository = getRuntimeRepository();
  const workflowRunId = state.agent_runtime.workflow_run_id;
  const detailJob = (await repository.listJobs(state.session_id, state.owner_id)).find((job) => {
    if (!isCurrentPreferredProductDetailJob(state, job)) return false;
    const moduleId = typeof job.payload.module_id === "string" ? job.payload.module_id : "";
    const preferred = state.module_candidates[moduleId]?.[0];
    return preferred?.detail_evidence?.job_id !== job.id;
  });
  if (detailJob) {
    if (
      detailJob.status === "pending" ||
      detailJob.status === "leased" ||
      detailJob.status === "running"
    ) {
      return { recovered: false, session_id: state.session_id };
    }
    if (detailJob.status === "completed") {
      await reconcileCompletedRuntimeJob(detailJob.id);
      await advanceAgentWorkflow(state.session_id, state.owner_id, { trigger: "recovery" });
      return { recovered: true, session_id: state.session_id, reason: "completed_result" };
    }
    if (detailJob.status === "failed" || detailJob.status === "cancelled") {
      await reconcileTerminalRuntimeJob(detailJob.id);
      await advanceAgentWorkflow(state.session_id, state.owner_id, { trigger: "recovery" });
      return { recovered: true, session_id: state.session_id, reason: "terminal_state" };
    }
  }
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
      if (await hasDeferredProductDetail(state.session_id, state.owner_id, job.id)) {
        return { recovered: true, session_id: state.session_id, reason: "completed_result" };
      }
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

  if (workflowRunId) {
    const orphanedTerminalJob = (await repository.listJobs(state.session_id, state.owner_id)).find((job) =>
      job.job_type === "module_search" &&
      job.idempotency_key.endsWith(`:${workflowRunId}`) &&
      (job.status === "completed" || job.status === "failed" || job.status === "cancelled") &&
      !state.hosted_tasks.some((task) => task.runtime_job_id === job.id)
    );

    if (orphanedTerminalJob?.status === "completed") {
      await reconcileCompletedRuntimeJob(orphanedTerminalJob.id);
      if (await hasDeferredProductDetail(state.session_id, state.owner_id, orphanedTerminalJob.id)) {
        return { recovered: true, session_id: state.session_id, reason: "completed_result" };
      }
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
