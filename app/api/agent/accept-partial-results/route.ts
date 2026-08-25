import { NextRequest } from "next/server";
import {
  acceptPartialAgentResults,
  AgentPartialResultsAcceptanceError
} from "@/lib/agent/workflow-runner";
import { ApiRouteError, apiOk, apiRouteError, requireString } from "@/lib/api/responses";
import { getRequestIdentity } from "@/lib/auth/request";
import { enforceWorkflowMutationRateLimit } from "@/lib/security/rate-limit";
import { readJsonObject } from "@/lib/api/validation";

export async function POST(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    await enforceWorkflowMutationRateLimit(request, identity.userId);
    const body = await readJsonObject(request);
    if (body.confirmed !== true) {
      throw new ApiRouteError(
        "使用已有部分结果进入选购需要用户显式确认。",
        400,
        "confirmation_required"
      );
    }

    const result = await acceptPartialAgentResults(
      requireString(body.session_id, "session_id"),
      identity.userId
    );
    return apiOk({
      state: result.state,
      skipped_module_id: result.skippedModuleId,
      preserved_candidate_count: result.preservedCandidateCount,
      completion_report: result.state.completion_report
    });
  } catch (error) {
    if (error instanceof AgentPartialResultsAcceptanceError) {
      return apiRouteError(
        new ApiRouteError(error.message, 409, error.code),
        "partial results acceptance failed"
      );
    }
    return apiRouteError(error, "partial results acceptance failed");
  }
}
