export type ExecutionMode = "codex_hosted" | "experimental_local" | "qoder_cli" | "local_executor";
export type PriorityStyle = "实用优先" | "舒适优先" | "安全优先" | "性价比优先";
export type RecommendationType = "稳妥推荐" | "性价比推荐" | "升级推荐";
export type MCPStatus = "hosted" | "connected" | "unavailable";
export type HostedTaskType = "module_search" | "add_to_cart";
export type HostedTaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type ScenarioId = "new-car" | "camping" | "room-decor" | "dorm-move-in" | "moving-setup";
export type WorkflowStage =
  | "landing"
  | "scenario_select"
  | "input_requirement"
  | "parsing"
  | "confirm_scene"
  | "planning"
  | "confirm_plan"
  | "searching"
  | "review_results"
  | "cart_review"
  | "refining"
  | "carting";
export type QuickAction = string;

export interface SceneBrief {
  scenario_id: ScenarioId;
  scene_type: string;
  vehicle_type: string;
  user_stage: string;
  budget: number;
  priority_style: PriorityStyle;
  already_have: string[];
  avoid_items: string[];
  optional_notes: string;
}

export interface PlanningModule {
  module_id: string;
  module_name: string;
  description: string;
  default_priority: number;
  default_budget_ratio: number;
  typical_item_types: string[];
  optional?: boolean;
}

export interface ModuleSearchStrategy {
  primary_keyword: string;
  alternate_keywords: string[];
  include_terms: string[];
  exclude_terms: string[];
  ranking_focus: string[];
  must_have_signals: string[];
  reject_signals: string[];
  quality_checks: string[];
  price_band: string;
  reasoning: string;
  failure_recovery: string;
}

export interface PlanExecutionStrategy {
  module_sequence: string[];
  budget_guardrails: string[];
  tradeoffs: string[];
  search_notes: string[];
  stop_rules: string[];
}

export type AgentAutonomyLevel = "保守执行" | "平衡执行" | "探索执行";
export type AgentSearchDepth = "轻量搜索" | "标准搜索" | "深度搜索";

export interface AgentDirectives {
  autonomy_level: AgentAutonomyLevel;
  search_depth: AgentSearchDepth;
  detail_policy: string;
  recovery_policy: string;
  rerank_rules: string[];
  user_confirmation_points: string[];
  safety_boundaries: string[];
}

export interface ShoppingPlanModule extends PlanningModule {
  origin?: "base_template" | "ai_adaptive";
  priority: number;
  budget_allocation: number;
  rationale: string;
  recommendation_strategy: string;
  search_keyword?: string;
  search_strategy?: ModuleSearchStrategy;
  status: "pending" | "ready" | "refined";
}

export interface ShoppingPlan {
  modules: ShoppingPlanModule[];
  overall_rationale: string;
  personalization_summary: string;
  execution_strategy: PlanExecutionStrategy;
  agent_directives: AgentDirectives;
}

export type PlanQualityStatus = "ready" | "needs_attention" | "risky";

export interface PlanQualityReview {
  status: PlanQualityStatus;
  source: "heuristic" | "deepseek";
  summary: string;
  strengths: string[];
  risks: string[];
  improvement_suggestions: string[];
  budget_comment: string;
  keyword_comment: string;
  module_comment: string;
  generated_at: string;
}

export interface ProductCandidate {
  product_id: string;
  title: string;
  price: number;
  source: string;
  shop_name: string;
  image_url: string;
  detail_url: string;
  shop_badges: string[];
  highlights: string[];
  risk_notes: string[];
  fit_reason: string;
  recommendation_type: RecommendationType;
  module_id: string;
}

export interface CandidateFitExplanation {
  product_id: string;
  fit_reason: string;
}

export type ModuleCandidateReviewStatus = "ready" | "needs_detail_check" | "thin" | "needs_refine";

export interface ModuleCandidateReview {
  module_id: string;
  status: ModuleCandidateReviewStatus;
  source: "heuristic" | "deepseek";
  summary: string;
  strengths: string[];
  caveats: string[];
  next_action: string;
  suggested_keyword?: string;
  generated_at: string;
}

export type ModuleSearchTraceStatus = "ready" | "recovered" | "thin" | "failed";
export type ModuleSearchAttemptStatus = "success" | "error" | "skipped";

export interface ModuleSearchAttempt {
  keyword: string;
  reason: string;
  result_count: number;
  status: ModuleSearchAttemptStatus;
  error_message?: string;
  created_at: string;
}

export interface ModuleSearchTrace {
  module_id: string;
  module_name: string;
  status: ModuleSearchTraceStatus;
  primary_keyword: string;
  searched_keywords: string[];
  attempts: ModuleSearchAttempt[];
  result_count: number;
  candidate_count: number;
  review_status?: ModuleCandidateReviewStatus;
  review_summary?: string;
  recovery_keyword?: string;
  ai_decision_summary: string;
  next_action: string;
  generated_at: string;
  updated_at: string;
}

export type ModuleMarketPressure = "unobserved" | "opportunity" | "healthy" | "tight" | "over_budget";
export type MarketFeedbackStatus = "insufficient_data" | "balanced" | "opportunity" | "under_pressure";
export type MarketSignalConfidence = "low" | "medium" | "high";

export interface ModuleMarketSignal {
  module_id: string;
  module_name: string;
  budget_allocation: number;
  candidate_count: number;
  priced_candidate_count: number;
  within_budget_count: number;
  minimum_price?: number;
  median_price?: number;
  reference_price?: number;
  budget_gap?: number;
  pressure: ModuleMarketPressure;
  confidence: MarketSignalConfidence;
  summary: string;
  suggested_keyword?: string;
}

export interface BudgetReallocationSuggestion {
  from_module_id: string;
  from_module_name: string;
  to_module_id: string;
  to_module_name: string;
  amount: number;
  reason: string;
  confidence: MarketSignalConfidence;
}

export interface MarketFeedback {
  status: MarketFeedbackStatus;
  observed_modules: number;
  total_modules: number;
  observed_planned_budget: number;
  observed_reference_total: number;
  observed_budget_gap: number;
  module_signals: Record<string, ModuleMarketSignal>;
  pressure_modules: string[];
  opportunity_modules: string[];
  reallocation_suggestions: BudgetReallocationSuggestion[];
  summary: string;
  user_confirmation_required: true;
  generated_at: string;
}

export type AgentDecisionAction =
  | "search_module"
  | "retry_module"
  | "skip_module"
  | "wait_for_tools"
  | "complete_workflow";

export type AgentDecisionSource =
  | "deepseek_runtime"
  | "plan_strategy"
  | "candidate_review"
  | "market_feedback"
  | "policy_fallback";
export type AgentDecisionConfidence = "high" | "medium" | "low";

export interface AgentDecision {
  decision_id: string;
  action: AgentDecisionAction;
  source: AgentDecisionSource;
  confidence: AgentDecisionConfidence;
  module_id?: string;
  module_name?: string;
  keyword_override?: string;
  reason: string;
  evidence: string[];
  expected_gain?: string;
  tool_cost?: number;
  guardrail_notes?: string[];
  decision_latency_ms?: number;
  created_at: string;
  consumed_at?: string;
}

export interface AgentDecisionProposal {
  action: AgentDecisionAction;
  confidence: AgentDecisionConfidence;
  module_id?: string;
  keyword_override?: string;
  reason: string;
  evidence: string[];
  expected_gain: string;
  tool_cost: number;
}

export interface AgentRuntimeState {
  max_tool_calls: number;
  used_tool_calls: number;
  model_decisions: number;
  policy_decisions: number;
  model_proposals: number;
  model_rejections: number;
  model_failures: number;
  total_decision_latency_ms: number;
  last_fallback_reason?: string;
  last_decision_at?: string;
  last_decision_mode: "deepseek" | "policy" | "none";
  workflow_status: "idle" | "running" | "waiting_for_tools" | "completed" | "paused" | "error";
  auto_continue: boolean;
  workflow_run_id?: string;
  current_module_id?: string;
  continuation_count: number;
  workflow_message: string;
  last_transition_at?: string;
  initialized_at: string;
}

export type RefinementModuleDecisionType = "needs_search" | "reused" | "removed";

export interface RefinementModuleDecision {
  module_id: string;
  module_name: string;
  decision: RefinementModuleDecisionType;
  reason: string;
}

export interface RefinementImpactSummary {
  quick_action: QuickAction;
  summary: string;
  impacted_modules: string[];
  reusable_modules: string[];
  removed_modules: string[];
  module_decisions: RefinementModuleDecision[];
  generated_at: string;
}

export interface MCPToolLog {
  id: string;
  timestamp: string;
  tool_name: string;
  module_id?: string;
  module_name?: string;
  input_summary: string;
  output_summary: string;
  status: "success" | "error" | "blocked";
  duration_ms: number;
  mode: ExecutionMode;
}

export interface HostedExecutionTask {
  task_id: string;
  task_type: HostedTaskType;
  session_id: string;
  status: HostedTaskStatus;
  title: string;
  description: string;
  module_id?: string;
  module_name?: string;
  product_id?: string;
  created_at: string;
  updated_at: string;
  payload: Record<string, unknown>;
  result_summary?: string;
  error_message?: string;
  executor?: "codex" | "qoder" | "local_executor";
  runtime_job_id?: string;
}

export interface SelectedItem {
  product_id: string;
  module_id: string;
  title: string;
  price: number;
  image_url?: string;
  detail_url?: string;
  shop_name?: string;
  module_name?: string;
  selected_spec?: string;
  cart_source?: "taobao" | "demo";
  cart_note?: string;
  added_at: string;
}

export interface SessionState {
  session_id: string;
  owner_id?: string;
  raw_input: string;
  scene_brief: SceneBrief;
  base_template: PlanningModule[];
  shopping_plan: ShoppingPlan;
  plan_review: PlanQualityReview;
  module_candidates: Record<string, ProductCandidate[]>;
  module_reviews: Record<string, ModuleCandidateReview>;
  module_search_traces: Record<string, ModuleSearchTrace>;
  market_feedback: MarketFeedback;
  agent_decisions: AgentDecision[];
  agent_runtime: AgentRuntimeState;
  selected_items: SelectedItem[];
  tool_logs: MCPToolLog[];
  hosted_tasks: HostedExecutionTask[];
  last_refinement?: RefinementImpactSummary;
  execution_mode: ExecutionMode;
  permissions_scope: string[];
  deepseek_status: "connected" | "mock";
  mcp_status: MCPStatus;
  current_scene_label: string;
  last_action?: string;
}
