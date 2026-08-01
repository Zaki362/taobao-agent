import { refinePlan } from "@/lib/llm/deepseek";
import { refreshMarketFeedback } from "@/lib/agent/market-feedback";
import { runDeepSeekPlanner } from "@/lib/agent/planner";
import { reviewPlanWithAgent } from "@/lib/agent/plan-reviewer";
import { removeModuleAgentDecisions } from "@/lib/agent/decision-engine";
import { invalidateAgentCompletionArtifacts } from "@/lib/session/bundle-adoption";
import { QuickAction, RefinementImpactSummary, RefinementModuleDecision, SessionState, ShoppingPlanModule } from "@/lib/session/types";

function textSignature(value: string | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function strategySignature(module: ShoppingPlanModule) {
  return [
    module.search_keyword,
    module.search_strategy?.primary_keyword,
    module.search_strategy?.alternate_keywords.join("|"),
    module.search_strategy?.include_terms.join("|"),
    module.search_strategy?.exclude_terms.join("|"),
    module.search_strategy?.ranking_focus.join("|"),
    module.search_strategy?.must_have_signals.join("|"),
    module.search_strategy?.reject_signals.join("|"),
    module.search_strategy?.quality_checks.join("|"),
    module.recommendation_strategy
  ]
    .map(textSignature)
    .join("::");
}

function budgetChangedEnough(previous: number, next: number) {
  const absoluteDelta = Math.abs(previous - next);
  const base = Math.max(previous, 1);
  return absoluteDelta >= 80 || absoluteDelta / base >= 0.18;
}

function selectImpactedModules(
  previousModules: ShoppingPlanModule[],
  nextModules: ShoppingPlanModule[],
  action: QuickAction
): RefinementImpactSummary {
  const previousById = new Map(previousModules.map((module) => [module.module_id, module]));
  const nextById = new Map(nextModules.map((module) => [module.module_id, module]));
  const moduleDecisions: RefinementModuleDecision[] = [];

  if (action === "换一批推荐") {
    const refreshModuleIds = nextModules.slice(0, 3).map((module) => module.module_id);
    for (const module of nextModules) {
      moduleDecisions.push({
        module_id: module.module_id,
        module_name: module.module_name,
        decision: refreshModuleIds.includes(module.module_id) ? "needs_search" : "reused",
        reason: refreshModuleIds.includes(module.module_id)
          ? "用户要求换一批推荐，优先刷新前置模块候选。"
          : "该模块规划未变，已有候选可以继续保留。"
      });
    }

    return {
      quick_action: action,
      summary: "已按“换一批推荐”刷新前置模块搜索任务，其余模块候选会尽量复用。",
      impacted_modules: refreshModuleIds,
      reusable_modules: nextModules.filter((module) => !refreshModuleIds.includes(module.module_id)).map((module) => module.module_id),
      removed_modules: previousModules.filter((module) => !nextById.has(module.module_id)).map((module) => module.module_id),
      module_decisions: moduleDecisions,
      generated_at: new Date().toISOString()
    };
  }

  for (const previousModule of previousModules) {
    if (!nextById.has(previousModule.module_id)) {
      moduleDecisions.push({
        module_id: previousModule.module_id,
        module_name: previousModule.module_name,
        decision: "removed",
        reason: "调整后该模块不再属于当前方案，相关候选会从本轮推荐中移除。"
      });
    }
  }

  for (const nextModule of nextModules) {
    const previousModule = previousById.get(nextModule.module_id);
    if (!previousModule) {
      moduleDecisions.push({
        module_id: nextModule.module_id,
        module_name: nextModule.module_name,
        decision: "needs_search",
        reason: "这是调整后新增的模块，需要重新搜索候选。"
      });
      continue;
    }

    const reasons: string[] = [];
    if (previousModule.priority !== nextModule.priority) {
      reasons.push("优先级发生变化");
    }
    if (budgetChangedEnough(previousModule.budget_allocation, nextModule.budget_allocation)) {
      reasons.push("预算分配变化较大");
    }
    if (strategySignature(previousModule) !== strategySignature(nextModule)) {
      reasons.push("搜索关键词或筛选策略已更新");
    }

    moduleDecisions.push({
      module_id: nextModule.module_id,
      module_name: nextModule.module_name,
      decision: reasons.length > 0 ? "needs_search" : "reused",
      reason: reasons.length > 0
        ? `${reasons.join("、")}，需要重新搜索以匹配新方案。`
        : "模块预算和搜索策略变化不大，已有候选可以继续复用。"
    });
  }

  const impactedModules = moduleDecisions
    .filter((decision) => decision.decision === "needs_search")
    .map((decision) => decision.module_id);
  const reusableModules = moduleDecisions
    .filter((decision) => decision.decision === "reused")
    .map((decision) => decision.module_id);
  const removedModules = moduleDecisions
    .filter((decision) => decision.decision === "removed")
    .map((decision) => decision.module_id);

  return {
    quick_action: action,
    summary: impactedModules.length > 0
      ? `已根据“${action}”重算方案，${impactedModules.length} 个模块需要重新搜索，${reusableModules.length} 个模块可复用已有候选。`
      : `已根据“${action}”重算方案，当前模块候选可优先复用。`,
    impacted_modules: impactedModules,
    reusable_modules: reusableModules,
    removed_modules: removedModules,
    module_decisions: moduleDecisions,
    generated_at: new Date().toISOString()
  };
}

export async function runRefiner(state: SessionState, action: QuickAction) {
  const previousModules = state.shopping_plan.modules;
  const refined = await refinePlan(state.scene_brief, action);
  state.scene_brief = refined.data;
  const plan = await runDeepSeekPlanner(state.scene_brief);
  const reviewed = await reviewPlanWithAgent(state.scene_brief, plan.data);
  state.shopping_plan = plan.data;
  state.plan_review = reviewed.data;
  state.deepseek_status =
    refined.mode === "connected" || plan.mode === "connected" || reviewed.mode === "connected" ? "connected" : "mock";
  state.last_action = action;

  const impacted = selectImpactedModules(previousModules, state.shopping_plan.modules, action);
  state.last_refinement = impacted;
  invalidateAgentCompletionArtifacts(state);

  for (const moduleId of [...impacted.impacted_modules, ...impacted.removed_modules]) {
    delete state.module_candidates[moduleId];
    delete state.module_reviews[moduleId];
    delete state.module_search_traces[moduleId];
    removeModuleAgentDecisions(state, moduleId);
  }
  refreshMarketFeedback(state);
  state.agent_runtime.workflow_status = "idle";
  state.agent_runtime.auto_continue = false;
  state.agent_runtime.current_module_id = undefined;
  state.agent_runtime.workflow_message = "方案已调整，等待用户确认后重新开始搜索";
  state.agent_runtime.last_transition_at = new Date().toISOString();

  return {
    state,
    impactedModules: impacted.impacted_modules,
    refinementImpact: impacted,
    mode: refined.mode
  };
}
