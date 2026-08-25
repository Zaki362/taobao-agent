import { NextRequest } from "next/server";
import { advanceAgentWorkflow } from "@/lib/agent/workflow-runner";
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
    const result = await withAiConcurrencyLimit(request, identity.userId, () =>
      advanceAgentWorkflow(sessionId, identity.userId, {
        start: true,
        trigger: "user_start"
      })
    );

    return apiOk({
      outcome: result.outcome,
      decision: result.decision,
      agent_runtime: result.state.agent_runtime,
      hosted_tasks: result.state.hosted_tasks
    });
  } catch (error) {
    return apiRouteError(error, "agent workflow start failed");
  }
}
