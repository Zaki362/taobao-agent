import { NextRequest } from "next/server";
import { ApiRouteError, apiOk, apiRouteError } from "@/lib/api/responses";
import { getRuntimeRepository } from "@/lib/runtime";
import { authenticateExecutorToken, bearerToken, DEFAULT_JOB_LEASE_MS } from "@/lib/runtime/jobs";
import { assertExecutorProtocol, EXECUTOR_PROTOCOL_VERSION } from "@/lib/runtime/executor-protocol";
import { recoverAgentWorkflowForExecutor } from "@/lib/agent/workflow-recovery";

export async function POST(request: NextRequest) {
  try {
    assertExecutorProtocol(request);
    const device = await authenticateExecutorToken(bearerToken(request));
    if (!device) throw new ApiRouteError("invalid executor token", 401, "invalid_executor_token");
    const repository = getRuntimeRepository();
    await repository.heartbeatDevice(device.id);
    let job = await repository.claimJob(device, DEFAULT_JOB_LEASE_MS);
    let recovery: {
      recovered: boolean;
      session_id?: string;
      reason?: "completed_result" | "terminal_state" | "missing_continuation";
      error?: string;
    } = { recovered: false };
    if (!job) {
      try {
        recovery = await recoverAgentWorkflowForExecutor(device);
      } catch (error) {
        recovery = {
          recovered: false,
          error: error instanceof Error ? error.message.slice(0, 300) : "workflow recovery failed"
        };
      }
    }
    if (!job && recovery.recovered) {
      job = await repository.claimJob(device, DEFAULT_JOB_LEASE_MS);
    }
    if (job) {
      await repository.appendEvent({
        user_id: job.user_id,
        session_id: job.session_id,
        job_id: job.id,
        event_type: "job.claimed",
        payload: { device_id: device.id, device_name: device.name, attempt: job.attempts }
      });
    }
    return apiOk({ job, recovery, protocol_version: EXECUTOR_PROTOCOL_VERSION });
  } catch (error) {
    return apiRouteError(error, "failed to claim executor job");
  }
}
