import { NextRequest } from "next/server";
import {
  AgentCompletionRecoveryError,
  improveAgentCompletionQuality,
  recoverAgentCompletionGaps
} from "@/lib/agent/workflow-runner";
import { ApiRouteError, apiOk, apiRouteError, requireString } from "@/lib/api/responses";
import { getRequestIdentity } from "@/lib/auth/request";

export async function POST(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    const body = await request.json().catch(() => ({}));
    if (body.confirmed !== true) {
      throw new ApiRouteError("必须由用户显式确认后才能继续执行完成报告建议。", 400, "confirmation_required");
    }

    const scope = body.scope === "thin" ? "thin" : "uncovered";
    const result = scope === "thin"
      ? await improveAgentCompletionQuality(
          requireString(body.session_id, "session_id"),
          identity.userId
        )
      : await recoverAgentCompletionGaps(
          requireString(body.session_id, "session_id"),
          identity.userId
        );
    const targetedModuleIds = "targeted_module_ids" in result
      ? result.targeted_module_ids
      : result.recovered_module_ids;

    return apiOk({
      scope,
      outcome: result.outcome,
      targeted_module_ids: targetedModuleIds,
      recovered_module_ids: scope === "uncovered" ? targetedModuleIds : [],
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
