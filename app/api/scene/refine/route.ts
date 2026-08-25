import { NextRequest } from "next/server";
import { refineSession } from "@/lib/agent/orchestrator";
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
    const quickAction = requireString(body.quick_action, "quick_action", 200);
    const result = await withAiConcurrencyLimit(
      request,
      identity.userId,
      () => refineSession(sessionId, quickAction, identity.userId)
    );
    return apiOk({
      session_id: result.state.session_id,
      scene_brief: result.state.scene_brief,
      shopping_plan: result.state.shopping_plan,
      plan_review: result.state.plan_review,
      module_candidates: result.state.module_candidates,
      hosted_tasks: result.state.hosted_tasks,
      tool_logs: result.state.tool_logs,
      impacted_modules: result.impactedModules,
      refinement_impact: result.refinementImpact
    });
  } catch (error) {
    return apiRouteError(error, "refine failed");
  }
}
