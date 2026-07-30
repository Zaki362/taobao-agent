import { NextRequest } from "next/server";
import { getNextAgentAction } from "@/lib/agent/orchestrator";
import { apiOk, apiRouteError, requireString } from "@/lib/api/responses";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const sessionId = requireString(body.session_id, "session_id");
    const result = await getNextAgentAction(sessionId);

    return apiOk({
      decision: result.decision,
      agent_decisions: result.state.agent_decisions
    });
  } catch (error) {
    return apiRouteError(error, "agent decision failed");
  }
}
