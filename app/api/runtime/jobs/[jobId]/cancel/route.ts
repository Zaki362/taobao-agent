import { NextRequest } from "next/server";
import { getRequestIdentity } from "@/lib/auth/request";
import { ApiRouteError, apiOk, apiRouteError } from "@/lib/api/responses";
import { cancelPendingRuntimeJob } from "@/lib/runtime/jobs";

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ jobId: string }> }
) {
  try {
    const identity = await getRequestIdentity();
    const { jobId } = await context.params;
    const job = await cancelPendingRuntimeJob(jobId, identity.userId);
    if (!job) {
      throw new ApiRouteError(
        "任务不存在、无权访问，或已经被执行器领取，无法安全取消",
        409,
        "job_not_cancellable"
      );
    }
    return apiOk({ job });
  } catch (error) {
    return apiRouteError(error, "failed to cancel runtime job");
  }
}
