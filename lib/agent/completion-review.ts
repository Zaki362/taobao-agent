import type {
  AgentCompletionReport,
  AgentDecision,
  SessionState
} from "@/lib/session/types";
import { buildPolicyPurchaseBundle } from "@/lib/agent/purchase-bundle";

function ratio(numerator: number, denominator: number) {
  if (denominator <= 0) return 1;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function moduleNames(state: SessionState, moduleIds: string[]) {
  const names = new Map(state.shopping_plan.modules.map((module) => [module.module_id, module.module_name]));
  return moduleIds.map((moduleId) => names.get(moduleId) ?? moduleId);
}

function skippedModuleIds(state: SessionState) {
  const skipped = new Set(
    state.agent_decisions
      .filter((decision) => decision.action === "skip_module" && decision.module_id)
      .map((decision) => decision.module_id as string)
  );
  return state.shopping_plan.modules
    .filter((module) => skipped.has(module.module_id) && (state.module_candidates[module.module_id]?.length ?? 0) === 0)
    .map((module) => module.module_id);
}

export function buildAgentCompletionReport(
  state: SessionState,
  decision?: AgentDecision
): AgentCompletionReport {
  const modules = state.shopping_plan.modules;
  const coveredModuleIds = modules
    .filter((module) => (state.module_candidates[module.module_id]?.length ?? 0) > 0)
    .map((module) => module.module_id);
  const criticalModuleIds = modules.filter((module) => !module.optional).map((module) => module.module_id);
  const coveredSet = new Set(coveredModuleIds);
  const uncoveredModuleIds = modules
    .filter((module) => !coveredSet.has(module.module_id))
    .map((module) => module.module_id);
  const criticalCoveredModuleIds = criticalModuleIds.filter((moduleId) => coveredSet.has(moduleId));
  const criticalUncoveredModuleIds = criticalModuleIds.filter((moduleId) => !coveredSet.has(moduleId));
  const skippedIds = skippedModuleIds(state);
  const thinModuleIds = modules
    .filter((module) => {
      const review = state.module_reviews[module.module_id];
      return review?.status === "thin" || review?.status === "needs_refine";
    })
    .map((module) => module.module_id);
  const budgetPressureModuleIds = modules
    .filter((module) => {
      const pressure = state.market_feedback.module_signals[module.module_id]?.pressure;
      return pressure === "tight" || pressure === "over_budget";
    })
    .map((module) => module.module_id);
  const unpricedModuleIds = coveredModuleIds.filter(
    (moduleId) => (state.market_feedback.module_signals[moduleId]?.priced_candidate_count ?? 0) === 0
  );
  const totalCandidates = Object.values(state.module_candidates)
    .reduce((total, candidates) => total + candidates.length, 0);
  const coverageRatio = ratio(coveredModuleIds.length, modules.length);
  const criticalCoverageRatio = ratio(criticalCoveredModuleIds.length, criticalModuleIds.length);

  const status: AgentCompletionReport["status"] = criticalUncoveredModuleIds.length > 0
    ? "needs_attention"
    : uncoveredModuleIds.length > 0 || thinModuleIds.length > 0 || budgetPressureModuleIds.length > 0 || unpricedModuleIds.length > 0
      ? "partial"
      : "ready";

  const strengths = [
    criticalCoveredModuleIds.length === criticalModuleIds.length
      ? `已覆盖全部 ${criticalModuleIds.length} 个必需模块。`
      : `已覆盖 ${criticalCoveredModuleIds.length}/${criticalModuleIds.length} 个必需模块。`,
    `本轮共保留 ${totalCandidates} 件候选，覆盖 ${coveredModuleIds.length}/${modules.length} 个规划模块。`
  ];
  if (state.agent_runtime.used_tool_calls > 0) {
    strengths.push(`Agent 在 ${state.agent_runtime.used_tool_calls}/${state.agent_runtime.max_tool_calls} 次工具预算内完成本轮收敛。`);
  }

  const caveats: string[] = [];
  const uncoveredWithoutSkip = uncoveredModuleIds.filter((moduleId) => !skippedIds.includes(moduleId));
  if (uncoveredWithoutSkip.length > 0) {
    caveats.push(`尚未形成候选覆盖：${moduleNames(state, uncoveredWithoutSkip).join("、")}。`);
  }
  if (skippedIds.length > 0) {
    caveats.push(`未形成候选并已容错跳过：${moduleNames(state, skippedIds).join("、")}。`);
  }
  if (thinModuleIds.length > 0) {
    caveats.push(`候选质量仍偏薄：${moduleNames(state, thinModuleIds).join("、")}。`);
  }
  if (budgetPressureModuleIds.length > 0) {
    caveats.push(`真实价格对模块预算形成压力：${moduleNames(state, budgetPressureModuleIds).join("、")}。`);
  }
  if (unpricedModuleIds.length > 0) {
    caveats.push(`缺少有效价格样本：${moduleNames(state, unpricedModuleIds).join("、")}。`);
  }

  const nextSteps: string[] = [];
  if (criticalUncoveredModuleIds.length > 0) {
    nextSteps.push(`优先重新搜索必需模块：${moduleNames(state, criticalUncoveredModuleIds).join("、")}。`);
  }
  if (thinModuleIds.length > 0) {
    nextSteps.push("可按候选池建议词局部补搜，不需要重跑全部模块。");
  }
  if (budgetPressureModuleIds.length > 0) {
    nextSteps.push("先查看预算内候选；跨模块预算调配仍需用户确认。");
  }
  if (nextSteps.length === 0) {
    nextSteps.push("进入商品对比；查看淘宝详情确认规格后，再显式选择是否加购。");
  }

  const summary = status === "ready"
    ? `本轮已覆盖全部必需模块并形成可比较候选，Agent 判断继续扩搜的边际收益较低。`
    : status === "needs_attention"
      ? `本轮仍有必需模块未形成候选，现有结果可先查看，但不应视为完整首购方案。`
      : `本轮已形成基础推荐覆盖，但仍有 ${caveats.length} 类质量或预算信号需要用户留意。`;

  return {
    status,
    source: decision?.source === "deepseek_runtime" ? "deepseek_runtime" : "policy",
    workflow_run_id: state.agent_runtime.workflow_run_id,
    decision_id: decision?.decision_id,
    total_modules: modules.length,
    covered_module_ids: coveredModuleIds,
    uncovered_module_ids: uncoveredModuleIds,
    critical_module_ids: criticalModuleIds,
    critical_covered_module_ids: criticalCoveredModuleIds,
    skipped_module_ids: skippedIds,
    thin_module_ids: thinModuleIds,
    budget_pressure_module_ids: budgetPressureModuleIds,
    unpriced_module_ids: unpricedModuleIds,
    total_candidates: totalCandidates,
    coverage_ratio: coverageRatio,
    critical_coverage_ratio: criticalCoverageRatio,
    stop_reason: decision?.reason || "规划模块均已形成候选或完成容错处理。",
    summary,
    strengths: strengths.slice(0, 3),
    caveats: caveats.slice(0, 4),
    next_steps: nextSteps.slice(0, 3),
    purchase_bundle: buildPolicyPurchaseBundle(state),
    generated_at: new Date().toISOString()
  };
}
