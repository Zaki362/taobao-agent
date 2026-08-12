import { NextRequest } from "next/server";
import { AgentWorkflowControlError, pauseAgentWorkflow } from "@/lib/agent/workflow-runner";
import { ApiRouteError, apiOk, apiRouteError, requireString } from "@/lib/api/responses";
import { getRequestIdentity } from "@/lib/auth/request";

export async function POST(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    const body = await request.json().catch(() => ({}));
    if (body.confirmed !== true) {
      throw new ApiRouteError("暂停 Agent 自动搜索需要用户显式确认。", 400, "confirmation_required");
    }
    const result = await pauseAgentWorkflow(
      requireString(body.session_id, "session_id"),
      identity.userId
    );
    return apiOk({
      outcome: result.outcome,
      state: result.state,
      agent_runtime: result.state.agent_runtime
    });
  } catch (error) {
    if (error instanceof AgentWorkflowControlError) {
      return apiRouteError(new ApiRouteError(error.message, 409, error.code), "agent workflow pause failed");
    }
    return apiRouteError(error, "agent workflow pause failed");
  }
}
