import { advanceAgentWorkflow } from "@/lib/agent/workflow-runner";
import { getRuntimeRepository } from "@/lib/runtime";
import { applyCompletedRuntimeJob, reconcileTerminalRuntimeJob } from "@/lib/runtime/jobs";
import type { ExecutorDevice } from "@/lib/runtime/types";

export interface WorkflowRecoveryResult {
  recovered: boolean;
  session_id?: string;
  reason?: "completed_result" | "terminal_state" | "missing_continuation";
}

export async function recoverAgentWorkflowForExecutor(
  device: ExecutorDevice
): Promise<WorkflowRecoveryResult> {
  if (!device.capabilities.includes("module_search")) return { recovered: false };

  const repository = getRuntimeRepository();
  const sessions = (await repository.listSessions(device.user_id))
    .filter((state) =>
      state.agent_runtime.auto_continue &&
      (state.agent_runtime.workflow_status === "running" ||
        state.agent_runtime.workflow_status === "waiting_for_tools")
    )
    .sort((a, b) =>
      (a.agent_runtime.last_transition_at ?? a.agent_runtime.initialized_at)
        .localeCompare(b.agent_runtime.last_transition_at ?? b.agent_runtime.initialized_at)
    );

  for (const state of sessions.slice(0, 25)) {
    const activeTask = state.hosted_tasks.find((task) =>
      task.task_type === "module_search" &&
      (task.status === "pending" || task.status === "running")
    );

    if (activeTask?.runtime_job_id) {
      const job = await repository.getJob(activeTask.runtime_job_id);
      if (!job || job.status === "pending" || job.status === "leased" || job.status === "running") {
        continue;
      }
      if (job.status === "completed") {
        await applyCompletedRuntimeJob(job.id, device, job.result ?? {});
        await advanceAgentWorkflow(state.session_id, device.user_id, { trigger: "recovery" });
        return { recovered: true, session_id: state.session_id, reason: "completed_result" };
      }
      if (job.status === "failed" || job.status === "cancelled") {
        await reconcileTerminalRuntimeJob(job.id);
        if (job.status === "failed") {
          await advanceAgentWorkflow(state.session_id, device.user_id, { trigger: "recovery" });
        }
        return { recovered: true, session_id: state.session_id, reason: "terminal_state" };
      }
      continue;
    }

    await advanceAgentWorkflow(state.session_id, device.user_id, { trigger: "recovery" });
    return { recovered: true, session_id: state.session_id, reason: "missing_continuation" };
  }

  return { recovered: false };
}
