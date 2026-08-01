import { NextRequest } from "next/server";
import { ApiRouteError, apiOk, apiRouteError } from "@/lib/api/responses";
import {
  applyCompletedRuntimeJob,
  applyFailedRuntimeJob,
  authenticateExecutorToken,
  bearerToken
} from "@/lib/runtime/jobs";
import { assertExecutorProtocol, EXECUTOR_PROTOCOL_VERSION } from "@/lib/runtime/executor-protocol";
import { advanceAgentWorkflow } from "@/lib/agent/workflow-runner";

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
    assertExecutorProtocol(request);
    const device = await authenticateExecutorToken(bearerToken(request));
    if (!device) throw new ApiRouteError("invalid executor token", 401, "invalid_executor_token");
    const { jobId } = await context.params;
    const body = await request.json().catch(() => ({}));
    if (body.status === "failed") {
      const job = await applyFailedRuntimeJob(
        jobId,
        device,
        typeof body.error === "string" ? body.error : "local executor failed",
        { retryable: body.retryable !== false }
      );
      const continuation =
        job.job_type === "module_search" && job.status === "failed"
          ? await continueWorkflow(job.session_id, job.user_id, "job_failed")
          : null;
      return apiOk({
        job,
        retry_scheduled: job.status === "pending",
        continuation,
        protocol_version: EXECUTOR_PROTOCOL_VERSION
      });
    }
    const result = body.result && typeof body.result === "object" && !Array.isArray(body.result)
      ? body.result as Record<string, unknown>
      : {};
    const completion = await applyCompletedRuntimeJob(jobId, device, result);
    const continuation = completion.job.job_type === "module_search" && !completion.alreadyCompleted
      ? await continueWorkflow(completion.job.session_id, completion.job.user_id, "job_completed")
      : null;
    return apiOk({
      job: completion.job,
      already_completed: completion.alreadyCompleted,
      continuation,
      protocol_version: EXECUTOR_PROTOCOL_VERSION
    });
  } catch (error) {
    return apiRouteError(error, "failed to resolve executor job");
  }
}
