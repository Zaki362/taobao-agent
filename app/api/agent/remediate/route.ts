import { NextRequest } from "next/server";
import {
  AgentCompletionRecoveryError,
  recoverAgentCompletionGaps
} from "@/lib/agent/workflow-runner";
import { ApiRouteError, apiOk, apiRouteError, requireString } from "@/lib/api/responses";
import { getRequestIdentity } from "@/lib/auth/request";

export async function POST(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    const body = await request.json().catch(() => ({}));
    if (body.confirmed !== true) {
      throw new ApiRouteError("必须由用户显式确认后才能重新搜索缺口模块。", 400, "confirmation_required");
    }

    const result = await recoverAgentCompletionGaps(
      requireString(body.session_id, "session_id"),
      identity.userId
    );

    return apiOk({
      outcome: result.outcome,
      recovered_module_ids: result.recovered_module_ids,
      agent_runtime: result.state.agent_runtime,
      hosted_tasks: result.state.hosted_tasks
    });
  } catch (error) {
    if (error instanceof AgentCompletionRecoveryError) {
      return apiRouteError(
        new ApiRouteError(error.message, 409, "completion_recovery_conflict"),
        "agent completion recovery failed"
      );
    }
    return apiRouteError(error, "agent completion recovery failed");
  }
}
