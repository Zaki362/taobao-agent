import { NextRequest } from "next/server";
import { ensureSession } from "@/lib/agent/orchestrator";
import { apiOk, apiRouteError, notFound, requireString } from "@/lib/api/responses";
import { resolveHostedAddToCartTask, resolveHostedModuleSearchTask } from "@/lib/mcp/hosted";
import { saveSession } from "@/lib/session/store";
import { isHostedExecutionTask, isProductCandidate } from "@/lib/session/guards";

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const sessionId = requireString(body.session_id, "session_id");
    const taskId = requireString(body.task_id, "task_id");
    const session = await ensureSession(sessionId);
    if (!session) {
      return notFound("session not found");
    }

    const task = session.hosted_tasks.filter(isHostedExecutionTask).find((entry) => entry.task_id === taskId);
    if (!task) {
      return notFound("task not found");
    }

    if (task.task_type === "module_search") {
      const candidates = Array.isArray(body.candidates)
        ? body.candidates.filter(isProductCandidate)
        : [];
      resolveHostedModuleSearchTask(session, {
        task_id: task.task_id,
        status: body.status === "failed" ? "failed" : "completed",
        candidates,
        result_summary: optionalString(body.result_summary),
        error_message: optionalString(body.error_message)
      });
    } else {
      resolveHostedAddToCartTask(session, {
        task_id: task.task_id,
        status: body.status === "failed" ? "failed" : "completed",
        result_summary: optionalString(body.result_summary),
        error_message: optionalString(body.error_message)
      });
    }

    saveSession(session);
    return apiOk({
      session_id: session.session_id,
      task,
      hosted_tasks: session.hosted_tasks,
      module_candidates: session.module_candidates,
      module_reviews: session.module_reviews,
      selected_items: session.selected_items
    });
  } catch (error) {
    return apiRouteError(error, "failed to resolve hosted task");
  }
}
