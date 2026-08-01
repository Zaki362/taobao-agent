import type {
  AgentPurchaseBundle,
  AgentPurchaseBundleItem,
  ProductCandidate,
  PurchaseBundleProposal,
  SceneBrief,
  SessionState,
  ShoppingPlanModule
} from "@/lib/session/types";

type BundleChoice = {
  candidate: ProductCandidate;
  module: ShoppingPlanModule;
  score: number;
};

type BundleSearchState = {
  choices: BundleChoice[];
  total: number;
  score: number;
  criticalCoverage: number;
};

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function candidateText(candidate: ProductCandidate) {
  return `${candidate.title} ${candidate.shop_name} ${candidate.shop_badges.join(" ")} ${candidate.highlights.join(" ")}`;
}

function eligibleCandidate(scene: SceneBrief, candidate: ProductCandidate) {
  if (!candidate.product_id || !Number.isFinite(candidate.price) || candidate.price <= 0) return false;
  const text = candidateText(candidate);
  return !scene.avoid_items.some((item) => item && text.includes(item)) &&
    !scene.already_have.some((item) => item && text.includes(item));
}

function recommendationScore(scene: SceneBrief, candidate: ProductCandidate) {
  if (scene.priority_style === "性价比优先") {
    return candidate.recommendation_type === "性价比推荐" ? 150 : candidate.recommendation_type === "稳妥推荐" ? 110 : 65;
  }
  if (scene.priority_style === "舒适优先") {
    return candidate.recommendation_type === "升级推荐" ? 145 : candidate.recommendation_type === "稳妥推荐" ? 120 : 90;
  }
  return candidate.recommendation_type === "稳妥推荐" ? 145 : candidate.recommendation_type === "性价比推荐" ? 120 : 80;
}

function choiceScore(scene: SceneBrief, module: ShoppingPlanModule, candidate: ProductCandidate) {
  const moduleImportance = module.optional ? 220 : 1_200;
  const priorityScore = Math.max(0, 130 - Math.max(1, module.priority)) * 3;
  const moduleBudgetScore = candidate.price <= module.budget_allocation
    ? 120
    : -Math.min(160, Math.round(((candidate.price - module.budget_allocation) / Math.max(1, module.budget_allocation)) * 100));
  const shopText = `${candidate.shop_name} ${candidate.shop_badges.join(" ")}`;
  const shopScore = shopText.includes("官方") ? 45 : shopText.includes("旗舰店") ? 35 : 0;
  return moduleImportance + priorityScore + recommendationScore(scene, candidate) + moduleBudgetScore + shopScore;
}

function betterBundle(candidate: BundleSearchState, current: BundleSearchState) {
  if (candidate.criticalCoverage !== current.criticalCoverage) {
    return candidate.criticalCoverage > current.criticalCoverage;
  }
  if (candidate.score !== current.score) {
    return candidate.score > current.score;
  }
  if (candidate.choices.length !== current.choices.length) {
    return candidate.choices.length > current.choices.length;
  }
  return candidate.total < current.total;
}

function bundleReason(choice: BundleChoice) {
  const budgetSignal = choice.candidate.price <= choice.module.budget_allocation
    ? "价格落在当前模块预算内"
    : "为保证整体组合价值，使用总预算吸收了该模块的价格压力";
  return `${choice.candidate.fit_reason} ${budgetSignal}。`;
}

function bundleFromChoices(
  state: SessionState,
  choices: BundleChoice[],
  source: AgentPurchaseBundle["source"],
  summary?: string,
  tradeoffs: string[] = [],
  reasonOverrides: Record<string, string> = {}
): AgentPurchaseBundle {
  const selectedModuleIds = choices.map((choice) => choice.module.module_id);
  const selectedSet = new Set(selectedModuleIds);
  const criticalModuleIds = state.shopping_plan.modules
    .filter((module) => !module.optional)
    .map((module) => module.module_id);
  const criticalSelectedModuleIds = criticalModuleIds.filter((moduleId) => selectedSet.has(moduleId));
  const total = roundMoney(choices.reduce((sum, choice) => sum + choice.candidate.price, 0));
  const budget = roundMoney(Math.max(0, state.scene_brief.budget));
  const omittedModuleIds = state.shopping_plan.modules
    .filter((module) => !selectedSet.has(module.module_id))
    .map((module) => module.module_id);
  const unpricedModules = omittedModuleIds.filter((moduleId) =>
    (state.module_candidates[moduleId] ?? []).length > 0 &&
    !(state.module_candidates[moduleId] ?? []).some((candidate) => eligibleCandidate(state.scene_brief, candidate))
  );
  const criticalOmitted = criticalModuleIds.filter((moduleId) => !selectedSet.has(moduleId));
  const caveats = [...tradeoffs];
  if (criticalOmitted.length > 0) {
    const names = criticalOmitted.map((moduleId) =>
      state.shopping_plan.modules.find((module) => module.module_id === moduleId)?.module_name ?? moduleId
    );
    caveats.push(`预算或候选质量不足，暂未纳入必需模块：${names.join("、")}。`);
  }
  if (unpricedModules.length > 0) {
    const names = unpricedModules.map((moduleId) =>
      state.shopping_plan.modules.find((module) => module.module_id === moduleId)?.module_name ?? moduleId
    );
    caveats.push(`以下模块缺少可核验价格，未进入组合：${names.join("、")}。`);
  }

  const items: AgentPurchaseBundleItem[] = [...choices]
    .sort((a, b) => a.module.priority - b.module.priority)
    .map((choice) => ({
      module_id: choice.module.module_id,
      module_name: choice.module.module_name,
      product_id: choice.candidate.product_id,
      title: choice.candidate.title,
      price: choice.candidate.price,
      recommendation_type: choice.candidate.recommendation_type,
      optional: Boolean(choice.module.optional),
      reason: reasonOverrides[choice.candidate.product_id] || bundleReason(choice)
    }));
  const status = criticalSelectedModuleIds.length === criticalModuleIds.length && items.length > 0
    ? "ready"
    : "partial";

  return {
    status,
    source,
    total_budget: budget,
    estimated_total: total,
    remaining_budget: roundMoney(Math.max(0, budget - total)),
    selected_module_ids: selectedModuleIds,
    omitted_module_ids: omittedModuleIds,
    critical_module_ids: criticalModuleIds,
    critical_selected_module_ids: criticalSelectedModuleIds,
    items,
    summary: summary?.trim() || (status === "ready"
      ? `Agent 在 ${budget} 元总预算内优先覆盖全部必需模块，并保留 ${roundMoney(budget - total)} 元余量。`
      : `Agent 已在 ${budget} 元总预算内形成当前可行组合，但仍有必需模块需要补充候选或调整预算。`),
    caveats: [...new Set(caveats.map((item) => item.trim()).filter(Boolean))].slice(0, 4),
    guardrails: [
      "只允许选择当前搜索已返回的商品 ID",
      "每个规划模块最多选择一件商品",
      "组合估算总价不得超过用户确认的总预算",
      "组合仅用于决策建议，不会自动加入购物车或下单"
    ],
    generated_at: new Date().toISOString()
  };
}

export function buildPolicyPurchaseBundle(state: SessionState): AgentPurchaseBundle {
  const modules = [...state.shopping_plan.modules].sort((a, b) => a.priority - b.priority);
  const budget = Math.max(0, state.scene_brief.budget);
  let best: BundleSearchState = { choices: [], total: 0, score: 0, criticalCoverage: 0 };

  function visit(index: number, current: BundleSearchState) {
    if (index >= modules.length) {
      if (betterBundle(current, best)) best = current;
      return;
    }

    const module = modules[index];
    visit(index + 1, current);
    const options = (state.module_candidates[module.module_id] ?? [])
      .filter((candidate) => candidate.module_id === module.module_id && eligibleCandidate(state.scene_brief, candidate))
      .map((candidate) => ({ candidate, score: choiceScore(state.scene_brief, module, candidate) }))
      .sort((a, b) => b.score - a.score || a.candidate.price - b.candidate.price)
      .slice(0, 3);
    for (const option of options) {
      const candidate = option.candidate;
      if (current.choices.some((choice) => choice.candidate.product_id === candidate.product_id)) continue;
      const nextTotal = roundMoney(current.total + candidate.price);
      if (nextTotal > budget) continue;
      visit(index + 1, {
        choices: [...current.choices, { candidate, module, score: option.score }],
        total: nextTotal,
        score: current.score + option.score,
        criticalCoverage: current.criticalCoverage + (module.optional ? 0 : 1)
      });
    }
  }

  visit(0, { choices: [], total: 0, score: 0, criticalCoverage: 0 });
  return bundleFromChoices(state, best.choices, "policy");
}

export function materializePurchaseBundleProposal(
  state: SessionState,
  proposal: PurchaseBundleProposal,
  fallback: AgentPurchaseBundle
) {
  const candidateById = new Map<string, { candidate: ProductCandidate; module: ShoppingPlanModule }>();
  const ambiguousCandidateIds = new Set<string>();
  for (const module of state.shopping_plan.modules) {
    for (const candidate of state.module_candidates[module.module_id] ?? []) {
      if (candidate.module_id === module.module_id && eligibleCandidate(state.scene_brief, candidate)) {
        const existing = candidateById.get(candidate.product_id);
        if (existing && existing.module.module_id !== module.module_id) {
          ambiguousCandidateIds.add(candidate.product_id);
          candidateById.delete(candidate.product_id);
          continue;
        }
        if (ambiguousCandidateIds.has(candidate.product_id)) continue;
        candidateById.set(candidate.product_id, { candidate, module });
      }
    }
  }

  const ids = proposal.selected_product_ids.map((item) => item.trim()).filter(Boolean);
  if (ids.length === 0 || new Set(ids).size !== ids.length || ids.length > state.shopping_plan.modules.length) {
    return null;
  }
  const usedModules = new Set<string>();
  const choices: BundleChoice[] = [];
  for (const productId of ids) {
    const entry = candidateById.get(productId);
    if (!entry || usedModules.has(entry.module.module_id)) return null;
    usedModules.add(entry.module.module_id);
    choices.push({
      ...entry,
      score: choiceScore(state.scene_brief, entry.module, entry.candidate)
    });
  }
  const total = roundMoney(choices.reduce((sum, choice) => sum + choice.candidate.price, 0));
  if (total > roundMoney(state.scene_brief.budget)) return null;
  const criticalSelected = choices.filter((choice) => !choice.module.optional).length;
  if (criticalSelected < fallback.critical_selected_module_ids.length) return null;

  const allowedIds = new Set(ids);
  const reasonOverrides = Object.fromEntries(
    proposal.reasons
      .filter((item) => allowedIds.has(item.product_id))
      .map((item) => [item.product_id, item.fit_reason.replace(/\s+/g, " ").trim().slice(0, 180)])
      .filter(([, reason]) => reason.length >= 6)
  );
  return bundleFromChoices(
    state,
    choices,
    "deepseek",
    proposal.summary.slice(0, 300),
    proposal.tradeoffs.slice(0, 4),
    reasonOverrides
  );
}
