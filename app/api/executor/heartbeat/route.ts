import { NextRequest } from "next/server";
import { ApiRouteError, apiOk, apiRouteError } from "@/lib/api/responses";
import { getRuntimeRepository } from "@/lib/runtime";
import { authenticateExecutorToken, bearerToken, DEFAULT_JOB_LEASE_MS } from "@/lib/runtime/jobs";

export async function POST(request: NextRequest) {
  try {
    const device = await authenticateExecutorToken(bearerToken(request));
    if (!device) throw new ApiRouteError("invalid executor token", 401, "invalid_executor_token");
    const body = await request.json().catch(() => ({}));
    const repository = getRuntimeRepository();
    const updated = await repository.heartbeatDevice(device.id);
    const currentJobId = typeof body.current_job_id === "string" ? body.current_job_id : undefined;
    const renewedJob = currentJobId
      ? await repository.renewJobLease(currentJobId, device.id, DEFAULT_JOB_LEASE_MS)
      : null;
    return apiOk({
      device: updated ? {
        id: updated.id,
        name: updated.name,
        status: updated.status,
        capabilities: updated.capabilities,
        last_heartbeat_at: updated.last_heartbeat_at
      } : null,
      lease_renewed: Boolean(renewedJob),
      server_time: new Date().toISOString()
    });
  } catch (error) {
    return apiRouteError(error, "executor heartbeat failed");
  }
}
