import { NextRequest } from "next/server";
import { getNextAgentAction } from "@/lib/agent/orchestrator";
import { apiOk, apiRouteError, requireString } from "@/lib/api/responses";
import { getRequestIdentity } from "@/lib/auth/request";
import { enforceAiRateLimit, withAiConcurrencyLimit } from "@/lib/security/rate-limit";
import { readJsonObject } from "@/lib/api/validation";

export async function POST(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    await enforceAiRateLimit(request, identity.userId);
    const body = await readJsonObject(request);
    const sessionId = requireString(body.session_id, "session_id");
    const result = await withAiConcurrencyLimit(
      request,
      identity.userId,
      () => getNextAgentAction(sessionId, identity.userId)
    );

    return apiOk({
      decision: result.decision,
      agent_decisions: result.state.agent_decisions
    });
  } catch (error) {
    return apiRouteError(error, "agent decision failed");
  }
}
