import { NextRequest } from "next/server";
import { apiOk, apiRouteError } from "@/lib/api/responses";
import { loadSessions } from "@/lib/session/repository";
import { getRequestIdentity } from "@/lib/auth/request";
import { summarizeShoppingSessions } from "@/lib/session/summaries";

const MAX_SESSION_LIST_TOOL_LOGS = 16;
const MAX_SESSION_LIST_HOSTED_TASKS = 16;
const MAX_SESSION_LIST_SELECTED_ITEMS = 30;
const MAX_SESSION_LIST_MODULE_CANDIDATES = 6;
const MAX_SESSION_LIST_SEARCH_TRACES = 12;
const MAX_SESSION_LIST_AGENT_DECISIONS = 24;
const MAX_SESSION_LIST_LLM_CALLS = 40;

function sessionTimestamp(sessionId: string) {
  const match = sessionId.match(/^session-(\d+)/);
  return match ? Number(match[1]) : 0;
}

function summarizeModuleCandidates<T>(moduleCandidates: Record<string, T[]>) {
  return Object.fromEntries(
    Object.entries(moduleCandidates).map(([moduleId, candidates]) => [
      moduleId,
      candidates.slice(0, MAX_SESSION_LIST_MODULE_CANDIDATES)
    ])
  );
}

function summarizeModuleSearchTraces<T>(moduleSearchTraces: Record<string, T>) {
  return Object.fromEntries(Object.entries(moduleSearchTraces).slice(0, MAX_SESSION_LIST_SEARCH_TRACES));
}

export async function GET(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    const storedSessions = await loadSessions(identity.userId);
    const archiveFilter = request.nextUrl.searchParams.get("archive") ?? "active";
    const filteredSessions = storedSessions.filter((session) => {
      if (archiveFilter === "all") return true;
      if (archiveFilter === "archived") return Boolean(session.archived_at);
      return !session.archived_at;
    });
    if (request.nextUrl.searchParams.get("view") === "summary") {
      const requestedLimit = Number(request.nextUrl.searchParams.get("limit") ?? 6);
      return apiOk({ sessions: summarizeShoppingSessions(filteredSessions, requestedLimit) });
    }

    const sessions = filteredSessions
      .sort((a, b) => sessionTimestamp(b.session_id) - sessionTimestamp(a.session_id))
      .map((session) => ({
        session_id: session.session_id,
        archived_at: session.archived_at,
        raw_input: session.raw_input,
        current_scene_label: session.current_scene_label,
        base_template: session.base_template,
        execution_mode: session.execution_mode,
        deepseek_status: session.deepseek_status,
        mcp_status: session.mcp_status,
        permissions_scope: session.permissions_scope,
        scene_brief: session.scene_brief,
        shopping_plan: session.shopping_plan,
        plan_review: session.plan_review,
        last_refinement: session.last_refinement,
        selected_items: session.selected_items.slice(0, MAX_SESSION_LIST_SELECTED_ITEMS),
        module_candidates: summarizeModuleCandidates(session.module_candidates),
        module_reviews: session.module_reviews,
        module_search_traces: summarizeModuleSearchTraces(session.module_search_traces),
        market_feedback: session.market_feedback,
        agent_decisions: session.agent_decisions.slice(-MAX_SESSION_LIST_AGENT_DECISIONS),
        agent_runtime: session.agent_runtime,
        llm_calls: session.llm_calls.slice(-MAX_SESSION_LIST_LLM_CALLS),
        completion_report: session.completion_report,
        bundle_adoption: session.bundle_adoption,
        tool_logs: session.tool_logs.slice(0, MAX_SESSION_LIST_TOOL_LOGS),
        hosted_tasks: session.hosted_tasks.slice(0, MAX_SESSION_LIST_HOSTED_TASKS)
      }));

    return apiOk({ sessions });
  } catch (error) {
    return apiRouteError(error, "failed to list sessions");
  }
}
