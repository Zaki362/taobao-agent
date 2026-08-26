import { NextRequest } from "next/server";
import { establishExecutorStartupStandby } from "@/lib/agent/workflow-runner";
import { ApiRouteError, apiOk, apiRouteError } from "@/lib/api/responses";
import { assertExecutorProtocol, EXECUTOR_PROTOCOL_VERSION } from "@/lib/runtime/executor-protocol";
import { authenticateExecutorToken, bearerToken } from "@/lib/runtime/jobs";

export async function POST(request: NextRequest) {
  try {
    assertExecutorProtocol(request);
    const device = await authenticateExecutorToken(bearerToken(request));
    if (!device) throw new ApiRouteError("invalid executor token", 401, "invalid_executor_token");
    const standby = device.capabilities.includes("module_search")
      ? await establishExecutorStartupStandby(device)
      : { paused_workflows: 0, paused_session_ids: [] as string[] };
    return apiOk({
      ...standby,
      startup_standby_established: true,
      protocol_version: EXECUTOR_PROTOCOL_VERSION
    });
  } catch (error) {
    return apiRouteError(error, "failed to establish executor startup standby");
  }
}
