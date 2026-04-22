import { PlanningModule, PriorityStyle, QuickAction, RecommendationType, ScenarioId } from "@/lib/session/types";

export type ScenarioFieldKey =
  | "vehicle_type"
  | "budget"
  | "priority_style"
  | "user_stage"
  | "avoid_items"
  | "already_have";

export interface ScenarioConfig {
  id: ScenarioId;
  name: string;
  short_description: string;
  landing_title: string;
  landing_subtitle: string;
  enabled: boolean;
  coming_soon: boolean;
  input_placeholder: string;
  example_prompts: string[];
  start_button_text: string;
  confirm_scene_title: string;
  confirm_scene_description: string;
  confirm_plan_title: string;
  confirm_plan_description: string;
  searching_status_text: string;
  results_page_title: string;
  results_intro_text: string;
  detail_button_text: string;
  cart_button_text: string;
  product_reason_style: Record<RecommendationType, string>;
  product_risk_style: string;
  quick_actions: QuickAction[];
  refine_summary_template: string;
  scene_brief_fields: ScenarioFieldKey[];
  field_labels: Record<ScenarioFieldKey, string>;
  field_option_sets: {
    vehicle_type?: string[];
    user_stage?: string[];
    priority_style?: PriorityStyle[];
    already_have?: string[];
    avoid_items?: string[];
  };
  base_template_modules: PlanningModule[];
  module_display_labels: Record<string, string>;
  module_help_text: Record<string, string>;
  planning_summary_template: string;
  result_tab_labels: Record<string, string>;
}
