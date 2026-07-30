import { NextRequest } from "next/server";
import { isAgentDirectiveProfile } from "@/lib/agent/directives";
import { updateAgentDirectiveProfile } from "@/lib/agent/orchestrator";
import { ApiRouteError, apiOk, apiRouteError, requireString } from "@/lib/api/responses";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const sessionId = requireString(body.session_id, "session_id");
    const profile = requireString(body.profile, "profile");
    if (!isAgentDirectiveProfile(profile)) {
      throw new ApiRouteError("profile must be conservative, balanced, or exploratory", 400, "bad_request");
    }

    const result = await updateAgentDirectiveProfile(sessionId, profile);
    return apiOk({
      session_id: result.state.session_id,
      agent_directives: result.directives,
      shopping_plan: result.state.shopping_plan,
      module_search_traces: result.state.module_search_traces
    });
  } catch (error) {
    return apiRouteError(error, "update agent directives failed");
  }
}

