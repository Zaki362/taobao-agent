import { getScenarioConfig } from "@/lib/scenarios";
import { PriorityStyle, QuickAction, WorkflowStage } from "@/lib/session/types";

export const scenarioOptions = [
  { id: "new-car", label: "新车选购", description: "已支持", enabled: true },
  { id: "camping", label: "露营准备", description: "即将支持", enabled: false },
  { id: "room-decor", label: "房间装饰", description: "即将支持", enabled: false },
  { id: "dorm-move-in", label: "宿舍入学", description: "即将支持", enabled: false },
  { id: "moving-setup", label: "搬家置办", description: "即将支持", enabled: false }
] as const;

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
  cart_review: "确认下单",
  refining: "调整方案",
  carting: "加入购物车"
};

export const defaultInput = newCarConfig.example_prompts[0];
export const WORKFLOW_STORAGE_KEY = "scenecart-dashboard-state";
