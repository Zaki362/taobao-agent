import {
  AgentDecision,
  ModuleSearchTrace,
  SessionState,
  ShoppingPlanModule
} from "@/lib/session/types";

const MAX_AGENT_DECISIONS = 120;

function uniqueModules(state: SessionState) {
  const byId = new Map(state.shopping_plan.modules.map((module) => [module.module_id, module]));
  const ordered = state.shopping_plan.execution_strategy.module_sequence
    .map((moduleId) => byId.get(moduleId))
    .filter((module): module is ShoppingPlanModule => Boolean(module));

  for (const module of [...state.shopping_plan.modules].sort((a, b) => a.priority - b.priority)) {
    if (!ordered.some((item) => item.module_id === module.module_id)) {
      ordered.push(module);
    }
  }

  return ordered;
}

function activeSearchTask(state: SessionState, moduleId: string) {
  return state.hosted_tasks.some(
    (task) =>
      task.task_type === "module_search" &&
      task.module_id === moduleId &&
      (task.status === "pending" || task.status === "running")
  );
}

function hasSkippedModule(state: SessionState, moduleId: string) {
  return state.agent_decisions.some(
    (decision) => decision.module_id === moduleId && decision.action === "skip_module"
  );
}

function canRetryFromReview(state: SessionState, module: ShoppingPlanModule) {
  const review = state.module_reviews[module.module_id];
  const trace = state.module_search_traces[module.module_id];
  const suggestedKeyword = review?.suggested_keyword?.replace(/\s+/g, " ").trim();

  if (
    !review ||
    !suggestedKeyword ||
    (review.status !== "thin" && review.status !== "needs_refine") ||
    state.shopping_plan.agent_directives.autonomy_level === "保守执行" ||
    state.shopping_plan.agent_directives.search_depth === "轻量搜索"
  ) {
    return null;
  }

  if (trace?.searched_keywords.includes(suggestedKeyword)) {
    return null;
  }

  const retried = state.agent_decisions.some(
    (decision) =>
      decision.module_id === module.module_id &&
      decision.action === "retry_module" &&
      decision.keyword_override === suggestedKeyword
  );

  return retried ? null : suggestedKeyword;
}

function failedWithoutCandidates(trace: ModuleSearchTrace | undefined, candidateCount: number) {
  return candidateCount === 0 && trace?.status === "failed";
}

function makeDecision(
  decision: Omit<AgentDecision, "decision_id" | "created_at">
): AgentDecision {
  const now = Date.now();
  return {
    ...decision,
    decision_id: `agent-decision-${now}-${Math.random().toString(36).slice(2, 7)}`,
    created_at: new Date(now).toISOString()
  };
}

export function decideNextAgentAction(state: SessionState): AgentDecision {
  const modules = uniqueModules(state);

  for (const module of modules) {
    const candidateCount = state.module_candidates[module.module_id]?.length ?? 0;
    if (candidateCount === 0) {
      continue;
    }

    const suggestedKeyword = canRetryFromReview(state, module);
    if (suggestedKeyword) {
      const review = state.module_reviews[module.module_id];
      return makeDecision({
        action: "retry_module",
        source: "candidate_review",
        confidence: review.source === "deepseek" ? "high" : "medium",
        module_id: module.module_id,
        module_name: module.module_name,
        keyword_override: suggestedKeyword,
        reason: review.next_action,
        evidence: [review.summary, ...review.caveats.slice(0, 2)]
      });
    }
  }

  for (const module of modules) {
    const candidateCount = state.module_candidates[module.module_id]?.length ?? 0;
    const trace = state.module_search_traces[module.module_id];

    if (candidateCount > 0 || hasSkippedModule(state, module.module_id)) {
      continue;
    }

    if (activeSearchTask(state, module.module_id)) {
      continue;
    }

    if (failedWithoutCandidates(trace, candidateCount)) {
      return makeDecision({
        action: "skip_module",
        source: "policy_fallback",
        confidence: "high",
        module_id: module.module_id,
        module_name: module.module_name,
        reason: `「${module.module_name}」已完成容错搜索但没有形成候选池，本轮先跳过，避免阻塞后续模块。`,
        evidence: [trace?.ai_decision_summary ?? "工具搜索失败", state.shopping_plan.agent_directives.recovery_policy]
      });
    }

    return makeDecision({
      action: "search_module",
      source: "plan_strategy",
      confidence: "high",
      module_id: module.module_id,
      module_name: module.module_name,
      reason:
        module.search_strategy?.reasoning ||
        `按照 AI 规划的执行顺序，下一步处理「${module.module_name}」。`,
      evidence: [
        `执行顺序：${state.shopping_plan.execution_strategy.module_sequence.join(" → ")}`,
        `模块预算：${module.budget_allocation} 元`,
        `自主档位：${state.shopping_plan.agent_directives.autonomy_level}`
      ]
    });
  }

  const activeTasks = state.hosted_tasks.filter(
    (task) => task.task_type === "module_search" && (task.status === "pending" || task.status === "running")
  );
  if (activeTasks.length > 0) {
    return makeDecision({
      action: "wait_for_tools",
      source: "policy_fallback",
      confidence: "high",
      reason: `仍有 ${activeTasks.length} 个搜索任务在工具侧执行，Agent 暂停提交新动作。`,
      evidence: activeTasks.slice(0, 3).map((task) => task.title)
    });
  }

  return makeDecision({
    action: "complete_workflow",
    source: "plan_strategy",
    confidence: "high",
    reason: "当前规划中的模块均已形成候选池或完成容错处理，本轮搜索可以结束。",
    evidence: [
      `已生成候选的模块：${modules.filter((module) => (state.module_candidates[module.module_id]?.length ?? 0) > 0).length}`,
      `已跳过模块：${modules.filter((module) => hasSkippedModule(state, module.module_id)).length}`
    ]
  });
}

export function recordAgentDecision(state: SessionState, decision: AgentDecision) {
  state.agent_decisions = [...state.agent_decisions, decision].slice(-MAX_AGENT_DECISIONS);
  return decision;
}

export function removeModuleAgentDecisions(state: SessionState, moduleId: string) {
  state.agent_decisions = state.agent_decisions.filter((decision) => decision.module_id !== moduleId);
}
