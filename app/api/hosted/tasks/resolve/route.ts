import { NextRequest } from "next/server";
import { ensureSession } from "@/lib/agent/orchestrator";
import { apiOk, apiRouteError, notFound, requireString } from "@/lib/api/responses";
import { resolveHostedAddToCartTask, resolveHostedModuleSearchTask } from "@/lib/mcp/hosted";
import { persistSession } from "@/lib/session/repository";
import { isHostedExecutionTask, isProductCandidate } from "@/lib/session/guards";
import { getLegacyHostedAccess } from "@/lib/auth/hosted-worker";
import { advanceAgentWorkflow } from "@/lib/agent/workflow-runner";
import { reviewModuleCandidatesWithAgent } from "@/lib/agent/candidate-reviewer";
import { mergeAndRankModuleCandidates } from "@/lib/agent/candidate-ranker";

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function POST(request: NextRequest) {
  try {
    const access = await getLegacyHostedAccess(request);
    const body = await request.json().catch(() => ({}));
    const sessionId = requireString(body.session_id, "session_id");
    const taskId = requireString(body.task_id, "task_id");
    const session = await ensureSession(sessionId, access.userId);
    if (!session) {
      return notFound("session not found");
    }

    const task = session.hosted_tasks.filter(isHostedExecutionTask).find((entry) => entry.task_id === taskId);
    if (!task) {
      return notFound("task not found");
    }

    if (task.task_type === "module_search") {
      let candidates = Array.isArray(body.candidates)
        ? body.candidates.filter(isProductCandidate)
        : [];
      const module = session.shopping_plan.modules.find((item) => item.module_id === task.module_id);
      if (module) {
        candidates = mergeAndRankModuleCandidates(
          session.scene_brief,
          module,
          session.module_candidates[module.module_id] ?? [],
          candidates,
          {
            rerank_rules: session.shopping_plan.agent_directives.rerank_rules,
            budget_guardrails: session.shopping_plan.execution_strategy.budget_guardrails
          }
        ).candidates;
      }
      const assessment = body.status !== "failed" && module && candidates.length > 0
        ? await reviewModuleCandidatesWithAgent(session, module, candidates)
        : null;
      if (assessment) {
        candidates = assessment.candidates;
      }
      resolveHostedModuleSearchTask(session, {
        task_id: task.task_id,
        status: body.status === "failed" ? "failed" : "completed",
        candidates,
        review: assessment?.review,
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

    await persistSession(session);
    const continuation = task.task_type === "module_search" && session.agent_runtime.auto_continue
      ? await advanceAgentWorkflow(session.session_id, access.userId, {
          trigger: "legacy_task_resolved"
        }).then((result) => ({ outcome: result.outcome, error: null })).catch((error) => ({
            outcome: "paused" as const,
            error: error instanceof Error ? error.message : "agent continuation failed"
          }))
      : null;
    return apiOk({
      session_id: session.session_id,
      task,
      hosted_tasks: session.hosted_tasks,
      module_candidates: session.module_candidates,
      module_reviews: session.module_reviews,
      selected_items: session.selected_items,
      continuation
    });
  } catch (error) {
    return apiRouteError(error, "failed to resolve hosted task");
  }
}
