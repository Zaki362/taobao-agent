import { AgentDecisionProposal, ModuleCandidateReview, PlanningModule, SceneBrief, ShoppingPlan } from "@/lib/session/types";

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
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

export function validateShoppingPlanOutput(value: unknown, template: PlanningModule[]): ValidationResult {
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

  const allowedModuleIds = new Set(template.map((module) => module.module_id));
  const seenModuleIds = new Set<string>();

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
          return { valid: false, reason: `execution_strategy 包含模板外模块：${String(moduleId)}` };
        }
      }
    }
  }

  for (const item of value.modules) {
    if (!isRecord(item)) {
      return { valid: false, reason: "Shopping Plan 模块不是对象" };
    }

    if (!hasText(item.module_id)) {
      return { valid: false, reason: "Shopping Plan 模块缺少 module_id" };
    }

    const moduleId = String(item.module_id);
    if (!allowedModuleIds.has(moduleId)) {
      return { valid: false, reason: `Shopping Plan 包含模板外模块：${moduleId}` };
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

export function validateCandidateReviewOutput(value: unknown): value is Partial<ModuleCandidateReview> {
  if (!isRecord(value)) {
    return false;
  }

  const status = value.status;
  const validStatus =
    status === "ready" ||
    status === "needs_detail_check" ||
    status === "thin" ||
    status === "needs_refine";

  return (
    hasText(value.module_id) &&
    validStatus &&
    hasText(value.summary) &&
    Array.isArray(value.strengths) &&
    Array.isArray(value.caveats) &&
    hasText(value.next_action)
  );
}
