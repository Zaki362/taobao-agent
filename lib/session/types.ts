export type ExecutionMode = "codex_hosted" | "experimental_local" | "qoder_cli";
export type PriorityStyle = "实用优先" | "舒适优先" | "安全优先" | "性价比优先";
export type RecommendationType = "稳妥推荐" | "性价比推荐" | "升级推荐";
export type MCPStatus = "hosted" | "connected" | "unavailable";
export type HostedTaskType = "module_search" | "add_to_cart";
export type HostedTaskStatus = "pending" | "running" | "completed" | "failed";
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
  | "confirm_refine"
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

export interface ShoppingPlanModule extends PlanningModule {
  priority: number;
  budget_allocation: number;
  rationale: string;
  recommendation_strategy: string;
  search_keyword?: string;
  status: "pending" | "ready" | "refined";
}

export interface ShoppingPlan {
  modules: ShoppingPlanModule[];
  overall_rationale: string;
  personalization_summary: string;
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
  raw_input: string;
  scene_brief: SceneBrief;
  base_template: PlanningModule[];
  shopping_plan: ShoppingPlan;
  module_candidates: Record<string, ProductCandidate[]>;
  selected_items: SelectedItem[];
  tool_logs: MCPToolLog[];
  hosted_tasks: HostedExecutionTask[];
  execution_mode: ExecutionMode;
  permissions_scope: string[];
  deepseek_status: "connected" | "mock";
  mcp_status: MCPStatus;
  current_scene_label: string;
  last_action?: string;
}
