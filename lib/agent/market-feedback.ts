import type {
  BudgetReallocationSuggestion,
  MarketFeedback,
  MarketSignalConfidence,
  ModuleMarketPressure,
  ModuleMarketSignal,
  ProductCandidate,
  SessionState,
  ShoppingPlanModule
} from "@/lib/session/types";

const MAX_REALLOCATION_RATIO = 0.15;

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function median(values: number[]) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? roundMoney((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

function confidenceForCount(count: number): MarketSignalConfidence {
  if (count >= 3) return "high";
  if (count >= 2) return "medium";
  return "low";
}

function compactKeyword(module: ShoppingPlanModule) {
  const primary = module.search_strategy?.primary_keyword || module.search_keyword || module.module_name;
  const terms = primary.split(/\s+/).filter(Boolean);
  const withoutPriceTerms = terms.filter((term) => !/性价比|平价|低价|优惠|入门/.test(term));
  return [...withoutPriceTerms.slice(0, 6), "高性价比", "入门款"].join(" ").slice(0, 80);
}

function pressureForPrices(prices: number[], budget: number): ModuleMarketPressure {
  if (prices.length === 0 || budget <= 0) return "unobserved";
  const minimumPrice = prices[0];
  const medianPrice = median(prices) ?? minimumPrice;
  const withinBudgetCount = prices.filter((price) => price <= budget).length;

  if (minimumPrice > budget) return "over_budget";
  if (withinBudgetCount / prices.length < 0.5 || medianPrice > budget) return "tight";
  if (medianPrice <= budget * 0.65) return "opportunity";
  return "healthy";
}

function signalSummary(
  module: ShoppingPlanModule,
  pressure: ModuleMarketPressure,
  pricedCount: number,
  withinBudgetCount: number,
  referencePrice?: number
) {
  if (pressure === "unobserved") {
    return `「${module.module_name}」还没有可用价格样本，暂不调整预算判断。`;
  }
  if (pressure === "over_budget") {
    return `「${module.module_name}」当前 ${pricedCount} 个价格样本均高于 ${roundMoney(module.budget_allocation)} 元模块预算。`;
  }
  if (pressure === "tight") {
    return `「${module.module_name}」只有 ${withinBudgetCount}/${pricedCount} 个候选在预算内，价格空间偏紧。`;
  }
  if (pressure === "opportunity") {
    return `「${module.module_name}」单件候选参考价约 ${referencePrice} 元，当前样本低于模块预算，存在潜在余量（仍需结合购买数量确认）。`;
  }
  return `「${module.module_name}」有 ${withinBudgetCount}/${pricedCount} 个候选在预算内，价格与规划基本匹配。`;
}

function buildModuleSignal(module: ShoppingPlanModule, candidates: ProductCandidate[]): ModuleMarketSignal {
  const prices = candidates
    .map((candidate) => candidate.price)
    .filter((price) => Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b);
  const withinBudgetPrices = prices.filter((price) => price <= module.budget_allocation);
  const pressure = pressureForPrices(prices, module.budget_allocation);
  const medianPrice = median(prices);
  const referencePrice = withinBudgetPrices.length > 0
    ? median(withinBudgetPrices)
    : prices[0];
  const budgetGap = referencePrice === undefined
    ? undefined
    : roundMoney(module.budget_allocation - referencePrice);

  return {
    module_id: module.module_id,
    module_name: module.module_name,
    budget_allocation: roundMoney(module.budget_allocation),
    candidate_count: candidates.length,
    priced_candidate_count: prices.length,
    within_budget_count: withinBudgetPrices.length,
    minimum_price: prices[0],
    median_price: medianPrice,
    reference_price: referencePrice,
    budget_gap: budgetGap,
    pressure,
    confidence: confidenceForCount(prices.length),
    summary: signalSummary(module, pressure, prices.length, withinBudgetPrices.length, referencePrice),
    suggested_keyword:
      pressure === "over_budget" || pressure === "tight"
        ? compactKeyword(module)
        : undefined
  };
}

function buildReallocationSuggestions(signals: ModuleMarketSignal[]) {
  const donors = signals
    .filter((signal) => signal.pressure === "opportunity" && (signal.budget_gap ?? 0) > 0)
    .map((signal) => ({
      signal,
      available: roundMoney(Math.min(
        signal.budget_allocation * MAX_REALLOCATION_RATIO,
        Math.max(0, signal.budget_gap ?? 0)
      ))
    }))
    .filter((item) => item.available >= 1)
    .sort((a, b) => b.available - a.available);
  const receivers = signals
    .filter((signal) => signal.pressure === "over_budget" && (signal.minimum_price ?? 0) > signal.budget_allocation)
    .map((signal) => ({
      signal,
      needed: roundMoney(Math.min(
        signal.budget_allocation * MAX_REALLOCATION_RATIO,
        Math.max(0, (signal.minimum_price ?? signal.budget_allocation) - signal.budget_allocation)
      ))
    }))
    .filter((item) => item.needed >= 1)
    .sort((a, b) => b.needed - a.needed);
  const suggestions: BudgetReallocationSuggestion[] = [];

  for (const receiver of receivers) {
    let remaining = receiver.needed;
    for (const donor of donors) {
      if (remaining < 1 || donor.available < 1) continue;
      const amount = roundMoney(Math.min(remaining, donor.available));
      donor.available = roundMoney(donor.available - amount);
      remaining = roundMoney(remaining - amount);
      suggestions.push({
        from_module_id: donor.signal.module_id,
        from_module_name: donor.signal.module_name,
        to_module_id: receiver.signal.module_id,
        to_module_name: receiver.signal.module_name,
        amount,
        reason: `真实候选显示「${donor.signal.module_name}」存在余量，而「${receiver.signal.module_name}」最低价格已超过原预算。`,
        confidence:
          donor.signal.confidence === "high" && receiver.signal.confidence === "high"
            ? "high"
            : donor.signal.confidence === "low" || receiver.signal.confidence === "low"
              ? "low"
              : "medium"
      });
    }
  }

  return suggestions.slice(0, 3);
}

export function buildMarketFeedback(
  state: Pick<SessionState, "scene_brief" | "shopping_plan" | "module_candidates">
): MarketFeedback {
  const signals = state.shopping_plan.modules.map((module) =>
    buildModuleSignal(module, state.module_candidates[module.module_id] ?? [])
  );
  const observed = signals.filter((signal) => signal.pressure !== "unobserved");
  const observedPlannedBudget = roundMoney(observed.reduce((sum, signal) => sum + signal.budget_allocation, 0));
  const observedReferenceTotal = roundMoney(observed.reduce((sum, signal) => sum + (signal.reference_price ?? 0), 0));
  const observedBudgetGap = roundMoney(observedPlannedBudget - observedReferenceTotal);
  const pressureModules = observed
    .filter((signal) => signal.pressure === "tight" || signal.pressure === "over_budget")
    .map((signal) => signal.module_id);
  const opportunityModules = observed
    .filter((signal) => signal.pressure === "opportunity")
    .map((signal) => signal.module_id);
  const status: MarketFeedback["status"] =
    observed.length < Math.min(2, state.shopping_plan.modules.length)
      ? "insufficient_data"
      : pressureModules.length > 0
        ? "under_pressure"
        : opportunityModules.length > 0
          ? "opportunity"
          : "balanced";
  const reallocationSuggestions = buildReallocationSuggestions(observed);
  const summary =
    status === "insufficient_data"
      ? `已观察 ${observed.length}/${state.shopping_plan.modules.length} 个模块，样本不足，Agent 暂不建议调整预算。`
      : status === "under_pressure"
        ? `真实候选显示 ${pressureModules.length} 个模块预算承压；Agent 会优先尝试更聚焦的性价比搜索词，并仅把预算调整作为待确认建议。`
        : status === "opportunity"
          ? `当前单件候选价格整体可控，${opportunityModules.length} 个模块存在潜在余量；实际调配仍需结合购买数量并由用户确认。`
          : "已搜索模块的候选价格与预算规划基本匹配，暂不需要跨模块调整。";

  return {
    status,
    observed_modules: observed.length,
    total_modules: state.shopping_plan.modules.length,
    observed_planned_budget: observedPlannedBudget,
    observed_reference_total: observedReferenceTotal,
    observed_budget_gap: observedBudgetGap,
    module_signals: Object.fromEntries(signals.map((signal) => [signal.module_id, signal])),
    pressure_modules: pressureModules,
    opportunity_modules: opportunityModules,
    reallocation_suggestions: reallocationSuggestions,
    summary,
    user_confirmation_required: true,
    generated_at: new Date().toISOString()
  };
}

export function refreshMarketFeedback(state: SessionState) {
  state.market_feedback = buildMarketFeedback(state);
  return state.market_feedback;
}
