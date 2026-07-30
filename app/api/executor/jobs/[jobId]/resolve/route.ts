import { NextRequest } from "next/server";
import { ApiRouteError, apiOk, apiRouteError } from "@/lib/api/responses";
import {
  applyCompletedRuntimeJob,
  applyFailedRuntimeJob,
  authenticateExecutorToken,
  bearerToken
} from "@/lib/runtime/jobs";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> }
) {
  try {
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
      return apiOk({ job, retry_scheduled: job.status === "pending" });
    }
    const result = body.result && typeof body.result === "object" && !Array.isArray(body.result)
      ? body.result as Record<string, unknown>
      : {};
    const completion = await applyCompletedRuntimeJob(jobId, device, result);
    return apiOk({ job: completion.job, already_completed: completion.alreadyCompleted });
  } catch (error) {
    return apiRouteError(error, "failed to resolve executor job");
  }
}
