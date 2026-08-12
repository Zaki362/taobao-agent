import { getScenarioConfig, SCENARIO_LIST } from "@/lib/scenarios";
import { PriorityStyle, QuickAction, WorkflowStage } from "@/lib/session/types";

export const scenarioOptions = SCENARIO_LIST.map((scenario) => ({
  id: scenario.id,
  label: scenario.name,
  description: scenario.short_description,
  enabled: scenario.enabled && !scenario.coming_soon
}));

const newCarConfig = getScenarioConfig("new-car");

export const requirementExamples = newCarConfig.example_prompts;
export const requirementPlaceholder = newCarConfig.input_placeholder;
export const startButtonText = newCarConfig.start_button_text;
export const vehicleOptions = newCarConfig.field_option_sets.vehicle_type ?? ["新能源车", "轿车", "SUV", "混动车", "MPV"];
export const stageOptions = newCarConfig.field_option_sets.user_stage ?? ["提车初期", "第一周", "第一阶段首购", "首月补齐"];
export const preferenceOptions: PriorityStyle[] = newCarConfig.field_option_sets.priority_style ?? ["实用优先", "舒适优先", "安全优先", "性价比优先"];
export const alreadyHaveOptions = newCarConfig.field_option_sets.already_have ?? ["行车记录仪", "车载手机支架", "应急启动电源", "车载充电器", "脚垫", "纸巾收纳"];
export const avoidItemOptions = newCarConfig.field_option_sets.avoid_items ?? ["装饰类", "香薰摆件", "高价升级款", "复杂安装类", "占空间收纳箱"];
export const quickActions: QuickAction[] = newCarConfig.quick_actions;

export const stageLabels: Record<WorkflowStage, string> = {
  landing: "场景入口",
  scenario_select: "场景选择",
  input_requirement: "输入需求",
  parsing: "理解需求",
  confirm_scene: "确认场景",
  planning: "生成规划",
  confirm_plan: "确认规划",
  searching: "执行搜索",
  review_results: "查看推荐",
  cart_review: "购买确认",
  refining: "调整方案",
  carting: "加入购物车"
};

export const defaultInput = "";
export const WORKFLOW_STORAGE_KEY = "scenecart-dashboard-state";
