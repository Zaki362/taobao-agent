import { NextRequest } from "next/server";
import { ApiRouteError, apiOk, apiRouteError } from "@/lib/api/responses";
import { getRuntimeRepository } from "@/lib/runtime";
import { authenticateExecutorToken, bearerToken, DEFAULT_JOB_LEASE_MS } from "@/lib/runtime/jobs";
import { assertExecutorProtocol, EXECUTOR_PROTOCOL_VERSION } from "@/lib/runtime/executor-protocol";

export async function POST(request: NextRequest) {
  try {
    assertExecutorProtocol(request);
    const device = await authenticateExecutorToken(bearerToken(request));
    if (!device) throw new ApiRouteError("invalid executor token", 401, "invalid_executor_token");
    const repository = getRuntimeRepository();
    await repository.heartbeatDevice(device.id);
    const job = await repository.claimJob(device, DEFAULT_JOB_LEASE_MS);
    if (job) {
      await repository.appendEvent({
        user_id: job.user_id,
        session_id: job.session_id,
        job_id: job.id,
        event_type: "job.claimed",
        payload: { device_id: device.id, device_name: device.name, attempt: job.attempts }
      });
    }
    return apiOk({ job, protocol_version: EXECUTOR_PROTOCOL_VERSION });
  } catch (error) {
    return apiRouteError(error, "failed to claim executor job");
  }
}
