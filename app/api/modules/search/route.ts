import { NextRequest } from "next/server";
import { searchModule } from "@/lib/agent/orchestrator";
import { apiOk, apiRouteError, requireString } from "@/lib/api/responses";
import { getRequestIdentity } from "@/lib/auth/request";

export async function POST(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    const body = await request.json().catch(() => ({}));
    const sessionId = requireString(body.session_id, "session_id");
    const moduleId = requireString(body.module_id, "module_id");
    const keywordOverride =
      typeof body.keyword_override === "string" && body.keyword_override.trim()
        ? body.keyword_override.trim().slice(0, 80)
        : undefined;
    const result = await searchModule(sessionId, moduleId, {
      keywordOverride
    }, identity.userId);
    return apiOk({
      candidates: result.candidates,
      module_reviews: result.state.module_reviews,
      module_search_traces: result.state.module_search_traces,
      hosted_tasks: result.state.hosted_tasks,
      tool_logs: result.state.tool_logs
    });
  } catch (error) {
    return apiRouteError(error, "module search failed");
  }
}
