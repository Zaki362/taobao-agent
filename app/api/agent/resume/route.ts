import { NextRequest } from "next/server";
import { AgentWorkflowControlError, resumeAgentWorkflow } from "@/lib/agent/workflow-runner";
import { ApiRouteError, apiOk, apiRouteError, requireString } from "@/lib/api/responses";
import { getRequestIdentity } from "@/lib/auth/request";
import { enforceAiRateLimit, withAiConcurrencyLimit } from "@/lib/security/rate-limit";
import { readJsonObject } from "@/lib/api/validation";

export async function POST(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    await enforceAiRateLimit(request, identity.userId);
    const body = await readJsonObject(request);
    if (body.confirmed !== true) {
      throw new ApiRouteError("继续 Agent 自动搜索需要用户显式确认。", 400, "confirmation_required");
    }
    const result = await withAiConcurrencyLimit(
      request,
      identity.userId,
      () => resumeAgentWorkflow(
        requireString(body.session_id, "session_id"),
        identity.userId,
        { retryAuthenticationFailure: body.retry_authentication_failure === true }
      )
    );
    return apiOk({
      outcome: result.outcome,
      decision: result.decision,
      state: result.state,
      agent_runtime: result.state.agent_runtime,
      hosted_tasks: result.state.hosted_tasks
    });
  } catch (error) {
    if (error instanceof AgentWorkflowControlError) {
      return apiRouteError(new ApiRouteError(error.message, 409, error.code), "agent workflow resume failed");
    }
    return apiRouteError(error, "agent workflow resume failed");
  }
}
