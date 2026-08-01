import {
  ExecutionMode,
  AgentDecision,
  HostedExecutionTask,
  MCPStatus,
  ModuleCandidateReview,
  MarketFeedback,
  ModuleSearchTrace,
  PlanQualityReview,
  ProductCandidate,
  RefinementImpactSummary,
  SelectedItem,
  SessionState
} from "@/lib/session/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isExecutionMode(value: unknown): value is ExecutionMode {
  return (
    value === "codex_hosted" ||
    value === "experimental_local" ||
    value === "qoder_cli" ||
    value === "local_executor"
  );
}

function isMcpStatus(value: unknown): value is MCPStatus {
  return value === "hosted" || value === "connected" || value === "unavailable";
}

export function isAgentDecision(value: unknown): value is AgentDecision {
  if (!isRecord(value)) {
    return false;
  }

  const validAction =
    value.action === "search_module" ||
    value.action === "retry_module" ||
    value.action === "skip_module" ||
    value.action === "wait_for_tools" ||
    value.action === "complete_workflow";
  const validSource =
    value.source === "plan_strategy" ||
    value.source === "candidate_review" ||
    value.source === "market_feedback" ||
    value.source === "policy_fallback" ||
    value.source === "deepseek_runtime";
  const validConfidence =
    value.confidence === "high" ||
    value.confidence === "medium" ||
    value.confidence === "low";

  return (
    typeof value.decision_id === "string" &&
    validAction &&
    validSource &&
    validConfidence &&
    (value.module_id === undefined || typeof value.module_id === "string") &&
    (value.module_name === undefined || typeof value.module_name === "string") &&
    (value.keyword_override === undefined || typeof value.keyword_override === "string") &&
    typeof value.reason === "string" &&
    isStringArray(value.evidence) &&
    (value.expected_gain === undefined || typeof value.expected_gain === "string") &&
    (value.tool_cost === undefined ||
      (typeof value.tool_cost === "number" && Number.isFinite(value.tool_cost))) &&
    (value.guardrail_notes === undefined || isStringArray(value.guardrail_notes)) &&
    (value.decision_latency_ms === undefined ||
      (typeof value.decision_latency_ms === "number" && Number.isFinite(value.decision_latency_ms))) &&
    (value.consumed_at === undefined || typeof value.consumed_at === "string") &&
    typeof value.created_at === "string"
  );
}

function isAgentRuntimeState(value: unknown) {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.max_tool_calls === "number" &&
    Number.isFinite(value.max_tool_calls) &&
    typeof value.used_tool_calls === "number" &&
    Number.isFinite(value.used_tool_calls) &&
    typeof value.model_decisions === "number" &&
    Number.isFinite(value.model_decisions) &&
    typeof value.policy_decisions === "number" &&
    Number.isFinite(value.policy_decisions) &&
    typeof value.model_proposals === "number" &&
    Number.isFinite(value.model_proposals) &&
    typeof value.model_rejections === "number" &&
    Number.isFinite(value.model_rejections) &&
    typeof value.model_failures === "number" &&
    Number.isFinite(value.model_failures) &&
    typeof value.total_decision_latency_ms === "number" &&
    Number.isFinite(value.total_decision_latency_ms) &&
    (value.last_fallback_reason === undefined || typeof value.last_fallback_reason === "string") &&
    (value.last_decision_at === undefined || typeof value.last_decision_at === "string") &&
    (value.last_decision_mode === "none" ||
      value.last_decision_mode === "deepseek" ||
      value.last_decision_mode === "policy") &&
    (value.workflow_status === "idle" ||
      value.workflow_status === "running" ||
      value.workflow_status === "waiting_for_tools" ||
      value.workflow_status === "completed" ||
      value.workflow_status === "paused" ||
      value.workflow_status === "error") &&
    typeof value.auto_continue === "boolean" &&
    (value.workflow_run_id === undefined || typeof value.workflow_run_id === "string") &&
    (value.current_module_id === undefined || typeof value.current_module_id === "string") &&
    typeof value.continuation_count === "number" &&
    Number.isFinite(value.continuation_count) &&
    typeof value.workflow_message === "string" &&
    (value.last_transition_at === undefined || typeof value.last_transition_at === "string") &&
    typeof value.initialized_at === "string"
  );
}

export function isMarketFeedback(value: unknown): value is MarketFeedback {
  if (!isRecord(value) || !isRecord(value.module_signals)) return false;
  const validStatus =
    value.status === "insufficient_data" ||
    value.status === "balanced" ||
    value.status === "opportunity" ||
    value.status === "under_pressure";
  const validSignals = Object.values(value.module_signals).every((signal) => {
    if (!isRecord(signal)) return false;
    const validPressure =
      signal.pressure === "unobserved" ||
      signal.pressure === "opportunity" ||
      signal.pressure === "healthy" ||
      signal.pressure === "tight" ||
      signal.pressure === "over_budget";
    const validConfidence = signal.confidence === "low" || signal.confidence === "medium" || signal.confidence === "high";
    return (
      typeof signal.module_id === "string" &&
      typeof signal.module_name === "string" &&
      typeof signal.budget_allocation === "number" &&
      Number.isFinite(signal.budget_allocation) &&
      typeof signal.candidate_count === "number" &&
      Number.isFinite(signal.candidate_count) &&
      typeof signal.priced_candidate_count === "number" &&
      Number.isFinite(signal.priced_candidate_count) &&
      typeof signal.within_budget_count === "number" &&
      Number.isFinite(signal.within_budget_count) &&
      validPressure &&
      validConfidence &&
      typeof signal.summary === "string"
    );
  });
  const validSuggestions = Array.isArray(value.reallocation_suggestions) && value.reallocation_suggestions.every((suggestion) =>
    isRecord(suggestion) &&
    typeof suggestion.from_module_id === "string" &&
    typeof suggestion.to_module_id === "string" &&
    typeof suggestion.amount === "number" &&
    Number.isFinite(suggestion.amount) &&
    typeof suggestion.reason === "string"
  );

  return (
    validStatus &&
    typeof value.observed_modules === "number" &&
    typeof value.total_modules === "number" &&
    typeof value.observed_planned_budget === "number" &&
    typeof value.observed_reference_total === "number" &&
    typeof value.observed_budget_gap === "number" &&
    validSignals &&
    isStringArray(value.pressure_modules) &&
    isStringArray(value.opportunity_modules) &&
    validSuggestions &&
    typeof value.summary === "string" &&
    value.user_confirmation_required === true &&
    typeof value.generated_at === "string"
  );
}

export function isPlanQualityReview(value: unknown): value is PlanQualityReview {
  if (!isRecord(value)) {
    return false;
  }

  const validStatus =
    value.status === "ready" ||
    value.status === "needs_attention" ||
    value.status === "risky";
  const validSource = value.source === "heuristic" || value.source === "deepseek";

  return (
    validStatus &&
    validSource &&
    typeof value.summary === "string" &&
    isStringArray(value.strengths) &&
    isStringArray(value.risks) &&
    isStringArray(value.improvement_suggestions) &&
    typeof value.budget_comment === "string" &&
    typeof value.keyword_comment === "string" &&
    typeof value.module_comment === "string" &&
    typeof value.generated_at === "string"
  );
}

export function isModuleCandidateReview(value: unknown): value is ModuleCandidateReview {
  if (!isRecord(value)) {
    return false;
  }

  const validStatus =
    value.status === "ready" ||
    value.status === "needs_detail_check" ||
    value.status === "thin" ||
    value.status === "needs_refine";
  const validSource = value.source === "heuristic" || value.source === "deepseek";

  return (
    typeof value.module_id === "string" &&
    value.module_id.trim().length > 0 &&
    validStatus &&
    validSource &&
    typeof value.summary === "string" &&
    isStringArray(value.strengths) &&
    isStringArray(value.caveats) &&
    typeof value.next_action === "string" &&
    (value.suggested_keyword === undefined || typeof value.suggested_keyword === "string") &&
    typeof value.generated_at === "string"
  );
}

export function isModuleSearchTrace(value: unknown): value is ModuleSearchTrace {
  if (!isRecord(value)) {
    return false;
  }

  const validStatus =
    value.status === "ready" ||
    value.status === "recovered" ||
    value.status === "thin" ||
    value.status === "failed";
  const validAttempts =
    Array.isArray(value.attempts) &&
    value.attempts.every((attempt) => {
      if (!isRecord(attempt)) {
        return false;
      }

      const validAttemptStatus =
        attempt.status === "success" ||
        attempt.status === "error" ||
        attempt.status === "skipped";

      return (
        typeof attempt.keyword === "string" &&
        typeof attempt.reason === "string" &&
        typeof attempt.result_count === "number" &&
        Number.isFinite(attempt.result_count) &&
        validAttemptStatus &&
        (attempt.error_message === undefined || typeof attempt.error_message === "string") &&
        typeof attempt.created_at === "string"
      );
    });

  return (
    typeof value.module_id === "string" &&
    typeof value.module_name === "string" &&
    validStatus &&
    typeof value.primary_keyword === "string" &&
    isStringArray(value.searched_keywords) &&
    validAttempts &&
    typeof value.result_count === "number" &&
    Number.isFinite(value.result_count) &&
    typeof value.candidate_count === "number" &&
    Number.isFinite(value.candidate_count) &&
    (value.review_status === undefined ||
      value.review_status === "ready" ||
      value.review_status === "needs_detail_check" ||
      value.review_status === "thin" ||
      value.review_status === "needs_refine") &&
    (value.review_summary === undefined || typeof value.review_summary === "string") &&
    (value.recovery_keyword === undefined || typeof value.recovery_keyword === "string") &&
    typeof value.ai_decision_summary === "string" &&
    typeof value.next_action === "string" &&
    typeof value.generated_at === "string" &&
    typeof value.updated_at === "string"
  );
}

export function isRefinementImpactSummary(value: unknown): value is RefinementImpactSummary {
  if (!isRecord(value)) {
    return false;
  }

  const decisions = value.module_decisions;
  const validDecisions =
    Array.isArray(decisions) &&
    decisions.every((item) => {
      if (!isRecord(item)) {
        return false;
      }

      const validDecision =
        item.decision === "needs_search" ||
        item.decision === "reused" ||
        item.decision === "removed";

      return (
        typeof item.module_id === "string" &&
        typeof item.module_name === "string" &&
        validDecision &&
        typeof item.reason === "string"
      );
    });

  return (
    typeof value.quick_action === "string" &&
    typeof value.summary === "string" &&
    isStringArray(value.impacted_modules) &&
    isStringArray(value.reusable_modules) &&
    isStringArray(value.removed_modules) &&
    validDecisions &&
    typeof value.generated_at === "string"
  );
}

export function isSessionState(value: unknown): value is SessionState {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.session_id === "string" &&
    typeof value.raw_input === "string" &&
    isRecord(value.scene_brief) &&
    Array.isArray(value.base_template) &&
    isRecord(value.shopping_plan) &&
    Array.isArray((value.shopping_plan as Record<string, unknown>).modules) &&
    isRecord(value.module_candidates) &&
    Array.isArray(value.selected_items) &&
    Array.isArray(value.tool_logs)
  );
}

export function isRenderableSessionState(value: unknown): value is SessionState {
  if (!isSessionState(value)) {
    return false;
  }

  return (
    isPlanQualityReview(value.plan_review) &&
    isRecord(value.module_reviews) &&
    (value.module_search_traces === undefined || isRecord(value.module_search_traces)) &&
    isMarketFeedback(value.market_feedback) &&
    Array.isArray(value.agent_decisions) &&
    isAgentRuntimeState(value.agent_runtime) &&
    Array.isArray(value.hosted_tasks) &&
    isExecutionMode(value.execution_mode) &&
    isStringArray(value.permissions_scope) &&
    (value.deepseek_status === "connected" || value.deepseek_status === "mock") &&
    isMcpStatus(value.mcp_status) &&
    typeof value.current_scene_label === "string"
  );
}


export function isHostedExecutionTask(value: unknown): value is HostedExecutionTask {
  if (!isRecord(value)) {
    return false;
  }

  const validType = value.task_type === "module_search" || value.task_type === "add_to_cart";
  const validStatus =
    value.status === "pending" ||
    value.status === "running" ||
    value.status === "completed" ||
    value.status === "failed" ||
    value.status === "cancelled";

  return (
    typeof value.task_id === "string" &&
    validType &&
    typeof value.session_id === "string" &&
    validStatus &&
    typeof value.title === "string" &&
    typeof value.description === "string" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string" &&
    isRecord(value.payload) &&
    (value.module_id === undefined || typeof value.module_id === "string") &&
    (value.module_name === undefined || typeof value.module_name === "string") &&
    (value.product_id === undefined || typeof value.product_id === "string")
  );
}

export function isProductCandidate(value: unknown): value is ProductCandidate {
  if (!isRecord(value)) {
    return false;
  }

  const validRecommendationType =
    value.recommendation_type === "稳妥推荐" ||
    value.recommendation_type === "性价比推荐" ||
    value.recommendation_type === "升级推荐";

  return (
    typeof value.product_id === "string" &&
    value.product_id.trim().length > 0 &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    typeof value.price === "number" &&
    Number.isFinite(value.price) &&
    value.price >= 0 &&
    typeof value.source === "string" &&
    typeof value.shop_name === "string" &&
    typeof value.image_url === "string" &&
    typeof value.detail_url === "string" &&
    Array.isArray(value.shop_badges) &&
    value.shop_badges.every((item) => typeof item === "string") &&
    Array.isArray(value.highlights) &&
    value.highlights.every((item) => typeof item === "string") &&
    Array.isArray(value.risk_notes) &&
    value.risk_notes.every((item) => typeof item === "string") &&
    typeof value.fit_reason === "string" &&
    validRecommendationType &&
    typeof value.module_id === "string" &&
    value.module_id.trim().length > 0
  );
}

export function isSelectedItem(value: unknown): value is SelectedItem {
  if (!isRecord(value)) {
    return false;
  }

  const validCartSource =
    value.cart_source === undefined ||
    value.cart_source === "taobao" ||
    value.cart_source === "demo";

  return (
    typeof value.product_id === "string" &&
    value.product_id.trim().length > 0 &&
    typeof value.module_id === "string" &&
    value.module_id.trim().length > 0 &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    typeof value.price === "number" &&
    Number.isFinite(value.price) &&
    value.price >= 0 &&
    (value.image_url === undefined || typeof value.image_url === "string") &&
    (value.detail_url === undefined || typeof value.detail_url === "string") &&
    (value.shop_name === undefined || typeof value.shop_name === "string") &&
    (value.module_name === undefined || typeof value.module_name === "string") &&
    (value.selected_spec === undefined || typeof value.selected_spec === "string") &&
    validCartSource &&
    (value.cart_note === undefined || typeof value.cart_note === "string") &&
    typeof value.added_at === "string"
  );
}
