import { AgentDecisionProposal, ModuleCandidateReview, PlanningModule, PurchaseBundleProposal, SceneBrief, ShoppingPlan } from "@/lib/session/types";

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export interface ShoppingPlanValidationOptions {
  maxAdaptiveModules?: number;
  adaptiveIdPrefix?: string;
  prohibitedTerms?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasBoundedText(value: unknown, maxLength: number) {
  return hasText(value) && String(value).trim().length <= maxLength;
}

function hasNumberLike(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value === "string") {
    return Number.isFinite(Number(value.replace(/[^\d.]/g, "")));
  }
  return false;
}

function hasStringListLike(value: unknown) {
  if (Array.isArray(value)) {
    return value.every(hasText);
  }
  return hasText(value);
}

function isOptionalStringListLike(value: unknown) {
  return value === undefined || hasStringListLike(value);
}

function numberLike(value: unknown) {
  if (!hasNumberLike(value)) return Number.NaN;
  return typeof value === "number" ? value : Number(String(value).replace(/[^\d.]/g, ""));
}

function budgetRatioLike(value: unknown) {
  const ratio = numberLike(value);
  return ratio > 1 && ratio <= 100 ? ratio / 100 : ratio;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function validateSceneBriefOutput(value: unknown): ValidationResult {
  if (!isRecord(value)) {
    return { valid: false, reason: "Scene Brief 不是对象" };
  }

  const usefulFields = [
    value.scene_type,
    value.vehicle_type,
    value.user_stage,
    value.priority_style,
    value.optional_notes
  ].filter(hasText);

  if (usefulFields.length < 2) {
    return { valid: false, reason: "Scene Brief 缺少足够的可用字段" };
  }

  if (!hasNumberLike(value.budget)) {
    return { valid: false, reason: "Scene Brief 缺少有效预算" };
  }

  return { valid: true };
}

export function validateAgentDecisionOutput(value: unknown): value is AgentDecisionProposal {
  if (!isRecord(value)) return false;
  const actions = ["search_module", "retry_module", "skip_module", "wait_for_tools", "complete_workflow"];
  const confidences = ["high", "medium", "low"];
  if (!actions.includes(String(value.action)) || !confidences.includes(String(value.confidence))) return false;
  if (!hasText(value.reason) || !hasText(value.expected_gain)) return false;
  if (!Array.isArray(value.evidence) || !value.evidence.every(hasText)) return false;
  if (typeof value.tool_cost !== "number" || !Number.isFinite(value.tool_cost) || value.tool_cost < 0) return false;
  if ((value.action === "search_module" || value.action === "retry_module" || value.action === "skip_module") && !hasText(value.module_id)) {
    return false;
  }
  return true;
}

export function validateShoppingPlanOutput(
  value: unknown,
  template: PlanningModule[],
  options: ShoppingPlanValidationOptions = {}
): ValidationResult {
  if (!isRecord(value)) {
    return { valid: false, reason: "Shopping Plan 不是对象" };
  }

  if (!Array.isArray(value.modules)) {
    return { valid: false, reason: "Shopping Plan 缺少 modules 数组" };
  }

  if (value.modules.length === 0) {
    return { valid: false, reason: "Shopping Plan 没有保留任何模块" };
  }

  if (!isRecord(value.agent_directives)) {
    return { valid: false, reason: "Shopping Plan 缺少 agent_directives 对象" };
  }

  const directives = value.agent_directives;
  if (!hasText(directives.autonomy_level) || !hasText(directives.search_depth)) {
    return { valid: false, reason: "agent_directives 缺少执行模式或搜索深度" };
  }
  if (
    !hasText(directives.detail_policy) ||
    !hasText(directives.recovery_policy) ||
    !hasStringListLike(directives.rerank_rules) ||
    !hasStringListLike(directives.user_confirmation_points) ||
    !hasStringListLike(directives.safety_boundaries)
  ) {
    return { valid: false, reason: "agent_directives 结构不完整" };
  }

  const maxAdaptiveModules = Math.max(0, Math.min(options.maxAdaptiveModules ?? 0, 2));
  const adaptiveIdPrefix = options.adaptiveIdPrefix ?? "adaptive-";
  const adaptiveIdPattern = new RegExp(`^${escapeRegExp(adaptiveIdPrefix)}[a-z0-9]+(?:-[a-z0-9]+)*$`);
  const prohibitedTerms = options.prohibitedTerms ?? [];
  const templateModuleIds = new Set(template.map((module) => module.module_id));
  const allowedModuleIds = new Set(templateModuleIds);
  const seenModuleIds = new Set<string>();
  let adaptiveModuleCount = 0;

  for (const item of value.modules) {
    if (!isRecord(item)) {
      return { valid: false, reason: "Shopping Plan 模块不是对象" };
    }

    if (!hasText(item.module_id)) {
      return { valid: false, reason: "Shopping Plan 模块缺少 module_id" };
    }

    const moduleId = String(item.module_id);
    const adaptiveModule = !templateModuleIds.has(moduleId);
    if (adaptiveModule) {
      adaptiveModuleCount += 1;
      if (adaptiveModuleCount > maxAdaptiveModules) {
        return { valid: false, reason: `自适应模块数量超过上限 ${maxAdaptiveModules}` };
      }
      if (!adaptiveIdPattern.test(moduleId) || moduleId.length > 56) {
        return { valid: false, reason: `自适应模块 ID 不合法：${moduleId}` };
      }
      if (!hasText(item.module_name) || !hasText(item.description)) {
        return { valid: false, reason: `自适应模块 ${moduleId} 缺少名称或描述` };
      }
      if (!hasNumberLike(item.default_priority) || !hasNumberLike(item.default_budget_ratio)) {
        return { valid: false, reason: `自适应模块 ${moduleId} 缺少模板优先级或预算比例` };
      }
      const budgetRatio = budgetRatioLike(item.default_budget_ratio);
      if (budgetRatio <= 0 || budgetRatio > 1) {
        return { valid: false, reason: `自适应模块 ${moduleId} 的预算比例超出安全范围` };
      }
      if (!Array.isArray(item.typical_item_types) || item.typical_item_types.length === 0 || item.typical_item_types.length > 6 || !item.typical_item_types.every(hasText)) {
        return { valid: false, reason: `自适应模块 ${moduleId} 的商品类型无效` };
      }
      const proposalText = JSON.stringify(item);
      const prohibitedTerm = prohibitedTerms.find((term) => term && proposalText.includes(term));
      if (prohibitedTerm) {
        return { valid: false, reason: `自适应模块 ${moduleId} 涉及禁止领域：${prohibitedTerm}` };
      }
      allowedModuleIds.add(moduleId);
    }

    if (seenModuleIds.has(moduleId)) {
      return { valid: false, reason: `Shopping Plan 重复模块：${moduleId}` };
    }
    seenModuleIds.add(moduleId);

    if (!hasNumberLike(item.priority)) {
      return { valid: false, reason: `模块 ${moduleId} 缺少有效 priority` };
    }

    if (!hasNumberLike(item.budget_allocation)) {
      return { valid: false, reason: `模块 ${moduleId} 缺少有效 budget_allocation` };
    }

    if (!hasText(item.rationale) || !hasText(item.recommendation_strategy)) {
      return { valid: false, reason: `模块 ${moduleId} 缺少规划解释` };
    }

    if (adaptiveModule && !isRecord(item.search_strategy)) {
      return { valid: false, reason: `自适应模块 ${moduleId} 必须提供完整搜索策略` };
    }

    if (item.search_strategy !== undefined) {
      if (!isRecord(item.search_strategy)) {
        return { valid: false, reason: `模块 ${moduleId} 的 search_strategy 不是对象` };
      }
      const strategy = item.search_strategy;
      if (!hasText(strategy.primary_keyword)) {
        return { valid: false, reason: `模块 ${moduleId} 缺少 search_strategy.primary_keyword` };
      }
      if (
        !isOptionalStringListLike(strategy.alternate_keywords) ||
        !isOptionalStringListLike(strategy.include_terms) ||
        !isOptionalStringListLike(strategy.exclude_terms) ||
        !isOptionalStringListLike(strategy.ranking_focus) ||
        !isOptionalStringListLike(strategy.must_have_signals) ||
        !isOptionalStringListLike(strategy.reject_signals) ||
        !isOptionalStringListLike(strategy.quality_checks)
      ) {
        return { valid: false, reason: `模块 ${moduleId} 的 search_strategy 列表字段无效` };
      }
    }
  }

  if (value.execution_strategy !== undefined) {
    if (!isRecord(value.execution_strategy)) {
      return { valid: false, reason: "Shopping Plan 的 execution_strategy 不是对象" };
    }

    const strategy = value.execution_strategy;
    if (strategy.module_sequence !== undefined && !Array.isArray(strategy.module_sequence)) {
      return { valid: false, reason: "execution_strategy.module_sequence 必须是数组" };
    }
    if (strategy.module_sequence !== undefined) {
      for (const moduleId of strategy.module_sequence) {
        if (typeof moduleId !== "string" || !allowedModuleIds.has(moduleId)) {
          return { valid: false, reason: `execution_strategy 包含未批准模块：${String(moduleId)}` };
        }
      }
    }
  }

  return { valid: true };
}

export function validateProductFitOutput(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 6 && value.trim().length <= 120;
}

export function validatePlanQualityReviewOutput(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const validStatus =
    value.status === "ready" ||
    value.status === "needs_attention" ||
    value.status === "risky";

  return (
    validStatus &&
    hasText(value.summary) &&
    Array.isArray(value.strengths) &&
    Array.isArray(value.risks) &&
    Array.isArray(value.improvement_suggestions) &&
    hasText(value.budget_comment) &&
    hasText(value.keyword_comment) &&
    hasText(value.module_comment)
  );
}

export function validateCandidateReviewOutput(
  value: unknown,
  candidateIds: string[] = []
): value is Partial<ModuleCandidateReview> & { fit_reasons?: Array<{ product_id: string; fit_reason: string }> } {
  if (!isRecord(value)) {
    return false;
  }

  const status = value.status;
  const validStatus =
    status === "ready" ||
    status === "needs_detail_check" ||
    status === "thin" ||
    status === "needs_refine";

  const reviewValid = (
    hasBoundedText(value.module_id, 100) &&
    validStatus &&
    hasBoundedText(value.summary, 400) &&
    Array.isArray(value.strengths) &&
    value.strengths.length <= 6 &&
    value.strengths.every((item) => hasBoundedText(item, 180)) &&
    Array.isArray(value.caveats) &&
    value.caveats.length <= 6 &&
    value.caveats.every((item) => hasBoundedText(item, 180)) &&
    hasBoundedText(value.next_action, 300) &&
    (value.suggested_keyword === undefined || typeof value.suggested_keyword === "string") &&
    (typeof value.suggested_keyword !== "string" || value.suggested_keyword.trim().length <= 100)
  );

  if (!reviewValid || candidateIds.length === 0) {
    return reviewValid;
  }

  if (!Array.isArray(value.fit_reasons) || value.fit_reasons.length !== candidateIds.length) {
    return false;
  }

  const allowedIds = new Set(candidateIds);
  const seenIds = new Set<string>();
  for (const item of value.fit_reasons) {
    if (!isRecord(item) || !hasText(item.product_id) || !hasText(item.fit_reason)) {
      return false;
    }
    const productId = String(item.product_id).trim();
    const reason = String(item.fit_reason).trim();
    if (!allowedIds.has(productId) || seenIds.has(productId) || reason.length < 6 || reason.length > 140) {
      return false;
    }
    seenIds.add(productId);
  }

  return seenIds.size === allowedIds.size;
}

export function validatePurchaseBundleProposalOutput(
  value: unknown,
  candidateIds: string[],
  maxItems: number,
  allowedRefinements: string[],
  moduleIds: string[]
): value is PurchaseBundleProposal {
  if (!isRecord(value) || !Array.isArray(value.selected_product_ids)) return false;
  if (!hasBoundedText(value.summary, 300)) return false;
  if (!Array.isArray(value.tradeoffs) || value.tradeoffs.length > 4 || !value.tradeoffs.every((item) => hasBoundedText(item, 180))) {
    return false;
  }

  const selectedIds = value.selected_product_ids;
  const allowedIds = new Set(candidateIds);
  const selectedSet = new Set<string>();
  if (selectedIds.length === 0 || selectedIds.length > maxItems) return false;
  for (const item of selectedIds) {
    if (!hasBoundedText(item, 160)) return false;
    const productId = String(item).trim();
    if (!allowedIds.has(productId) || selectedSet.has(productId)) return false;
    selectedSet.add(productId);
  }

  if (!Array.isArray(value.reasons) || value.reasons.length !== selectedSet.size) return false;
  const reasonIds = new Set<string>();
  for (const item of value.reasons) {
    if (!isRecord(item) || !hasBoundedText(item.product_id, 160) || !hasBoundedText(item.fit_reason, 180)) {
      return false;
    }
    const productId = String(item.product_id).trim();
    const reason = String(item.fit_reason).trim();
    if (!selectedSet.has(productId) || reasonIds.has(productId) || reason.length < 6) return false;
    reasonIds.add(productId);
  }
  if (reasonIds.size !== selectedSet.size) return false;

  if (
    !Array.isArray(value.suggested_refinements) ||
    value.suggested_refinements.length < 1 ||
    value.suggested_refinements.length > 3
  ) {
    return false;
  }
  const allowedActions = new Set(allowedRefinements);
  const allowedModuleIds = new Set(moduleIds);
  const seenActions = new Set<string>();
  for (const item of value.suggested_refinements) {
    if (
      !isRecord(item) ||
      !hasBoundedText(item.action, 80) ||
      !hasBoundedText(item.reason, 180) ||
      !Array.isArray(item.target_module_ids) ||
      item.target_module_ids.length > 6
    ) {
      return false;
    }
    const action = String(item.action).trim();
    const reason = String(item.reason).trim();
    if (!allowedActions.has(action) || seenActions.has(action) || reason.length < 6) return false;
    seenActions.add(action);
    const seenModuleIds = new Set<string>();
    for (const moduleIdValue of item.target_module_ids) {
      if (!hasBoundedText(moduleIdValue, 100)) return false;
      const moduleId = String(moduleIdValue).trim();
      if (!allowedModuleIds.has(moduleId) || seenModuleIds.has(moduleId)) return false;
      seenModuleIds.add(moduleId);
    }
  }
  return true;
}
