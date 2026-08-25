import { NextRequest } from "next/server";
import { API_INPUT_LIMITS, readJsonObject } from "@/lib/api/validation";
import { ApiRouteError, apiOk, apiRouteError } from "@/lib/api/responses";
import { getRuntimeRepository } from "@/lib/runtime";
import {
  applyCompletedRuntimeJob,
  applyFailedRuntimeJob,
  authenticateExecutorToken,
  bearerToken,
  isAcknowledgedAuthenticationFailureForDevice,
  shouldContinueWorkflowAfterFailure,
  shouldContinueWorkflowAfterCompletion
} from "@/lib/runtime/jobs";
import {
  assertExecutorProtocol,
  assertPreviousProtocolInFlightJob,
  EXECUTOR_PROTOCOL_VERSION,
  isPreviousExecutorProtocolDrain,
  receivedExecutorProtocol
} from "@/lib/runtime/executor-protocol";
import { advanceAgentWorkflow } from "@/lib/agent/workflow-runner";
import { allowUnownedRuntimeJobs } from "@/lib/runtime/product-mode";

async function continueWorkflow(sessionId: string, userId: string | undefined, trigger: "job_completed" | "job_failed") {
  try {
    const result = await advanceAgentWorkflow(sessionId, userId, { trigger });
    return { outcome: result.outcome, error: null };
  } catch (error) {
    return {
      outcome: "error",
      error: error instanceof Error ? error.message : "agent continuation failed"
    };
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> }
) {
  try {
    const drainingPreviousProtocol = isPreviousExecutorProtocolDrain(request);
    if (!drainingPreviousProtocol) assertExecutorProtocol(request);
    const device = await authenticateExecutorToken(bearerToken(request));
    if (!device) throw new ApiRouteError("invalid executor token", 401, "invalid_executor_token");
    const { jobId } = await context.params;
    const repository = getRuntimeRepository();
    const existingJob = await repository.getJob(jobId);
    if (
      !existingJob ||
      (existingJob.user_id
        ? existingJob.user_id !== device.user_id
        : !allowUnownedRuntimeJobs())
    ) {
      throw new ApiRouteError("job not found", 404, "job_not_found");
    }
    if (drainingPreviousProtocol) {
      assertPreviousProtocolInFlightJob(
        existingJob,
        device.id,
        { allowTerminalReplay: true }
      );
    }
    const responseProtocolVersion = drainingPreviousProtocol
      ? receivedExecutorProtocol(request)!
      : EXECUTOR_PROTOCOL_VERSION;
    const body = await readJsonObject(request, API_INPUT_LIMITS.executorBodyBytes);
    const leaseToken = drainingPreviousProtocol
      ? existingJob.lease_token ?? ""
      : typeof body.lease_token === "string" ? body.lease_token : "";
    if (!leaseToken) {
      throw new ApiRouteError("missing job lease token", 409, "job_lease_token_required");
    }
    if (body.status === "failed") {
      const job = await applyFailedRuntimeJob(
        jobId,
        device,
        typeof body.error === "string" ? body.error : "local executor failed",
        {
          retryable: body.retryable !== false,
          authenticationFailureCallback: body.failure_kind === "authentication_required",
          leaseToken
        }
      );
      const continuation = await shouldContinueWorkflowAfterFailure(job)
        ? await continueWorkflow(job.session_id, job.user_id, "job_failed")
        : null;
      const authenticationFailureAcknowledged =
        body.failure_kind === "authentication_required" &&
        await isAcknowledgedAuthenticationFailureForDevice(
          job,
          device.id,
          leaseToken
        );
      return apiOk({
        job,
        authentication_failure_acknowledged: authenticationFailureAcknowledged,
        retry_scheduled: job.status === "pending",
        continuation,
        protocol_version: responseProtocolVersion
      });
    }
    const result = body.result && typeof body.result === "object" && !Array.isArray(body.result)
      ? body.result as Record<string, unknown>
      : {};
    const completion = await applyCompletedRuntimeJob(jobId, device, result, leaseToken);
    const shouldContinue = await shouldContinueWorkflowAfterCompletion({
      job: completion.job,
      alreadyCompleted: completion.alreadyCompleted,
      followUpJobId: completion.follow_up_job_id
    });
    const continuation = shouldContinue
      ? await continueWorkflow(completion.job.session_id, completion.job.user_id, "job_completed")
      : null;
    return apiOk({
      job: completion.job,
      already_completed: completion.alreadyCompleted,
      follow_up_job_id: completion.follow_up_job_id,
      continuation,
      protocol_version: responseProtocolVersion
    });
  } catch (error) {
    return apiRouteError(error, "failed to resolve executor job");
  }
}
