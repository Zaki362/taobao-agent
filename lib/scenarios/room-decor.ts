import { ScenarioConfig } from "@/lib/scenarios/types";

export const roomDecorScenario: ScenarioConfig = {
  id: "room-decor",
  name: "房间装饰",
  short_description: "围绕风格和区域快速改善空间观感",
  landing_title: "房间装饰",
  landing_subtitle: "从桌面、床边和灯光氛围切入，低成本提升空间感受。",
  enabled: true,
  coming_soon: false,
  input_placeholder: "例如：想布置卧室，预算 800，风格简约温馨，优先提升氛围感",
  example_prompts: [
    "想布置卧室，预算 800，风格简约温馨，优先提升氛围感",
    "租房房间改造，预算 500，尽量低成本但显得整洁",
    "主要想改桌面和床边区域"
  ],
  start_button_text: "开始整理空间需求",
  confirm_scene_title: "确认房间装饰需求",
  confirm_scene_description: "先确认区域、风格和目标，再生成房间布置清单。",
  confirm_plan_title: "确认空间布置规划",
  confirm_plan_description: "先看区域模块和预算分配，再开始找候选商品。",
  searching_status_text: "正在按你的空间风格与区域偏好准备商品推荐",
  results_page_title: "房间布置推荐",
  results_intro_text: "围绕空间氛围、桌面整理和软装点缀，优先给出更适合当前风格的商品。",
  detail_button_text: "查看淘宝详情",
  cart_button_text: "加入购物车",
  product_reason_style: {
    "稳妥推荐": "适合快速提升空间观感，先建立整体氛围基调。",
    "性价比推荐": "更适合低成本改善空间感受，效果和预算更平衡。",
    "升级推荐": "适合希望质感或风格更完整的装饰选择。"
  },
  product_risk_style: "当前为搜索结果摘要，建议点开淘宝详情页确认尺寸、材质和是否需要安装",
  quick_actions: ["压缩预算", "只看氛围提升", "去掉大件", "更偏温馨", "更偏简约", "我已有台灯", "不想打孔安装", "换一批推荐"],
  refine_summary_template: "已按你的空间风格偏好更新规划，请确认后再开始搜索。",
  scene_brief_fields: ["vehicle_type", "budget", "priority_style", "user_stage", "avoid_items", "already_have"],
  field_labels: {
    vehicle_type: "空间区域",
    budget: "预算",
    priority_style: "风格偏好",
    user_stage: "目标",
    avoid_items: "排除项",
    already_have: "已有物品"
  },
  field_option_sets: {
    vehicle_type: ["卧室", "客厅", "桌面", "床边", "全屋局部"],
    user_stage: ["氛围提升", "收纳优化", "桌面整理", "灯光布置"],
    priority_style: ["实用优先", "舒适优先", "安全优先", "性价比优先"],
    already_have: ["台灯", "地毯", "收纳盒", "装饰画", "香薰灯", "边几"],
    avoid_items: ["不打孔", "不要大件家具", "不要复杂安装", "不要布艺地毯", "不要落地灯"]
  },
  base_template_modules: [
    { module_id: "decor-lighting", module_name: "灯光氛围", description: "先建立空间的光感和整体气氛。", default_priority: 96, default_budget_ratio: 0.22, typical_item_types: ["台灯", "氛围灯", "落地灯", "小夜灯"], optional: false },
    { module_id: "decor-bedside", module_name: "床边区域", description: "围绕床边和休息角落提升舒适与完整度。", default_priority: 78, default_budget_ratio: 0.16, typical_item_types: ["床边毯", "边几", "抱枕", "床头收纳"], optional: false },
    { module_id: "decor-desk", module_name: "桌面整理", description: "让桌面更整洁，也更有风格感。", default_priority: 88, default_budget_ratio: 0.18, typical_item_types: ["桌面收纳", "显示器增高架", "桌垫", "小摆件"], optional: false },
    { module_id: "decor-storage", module_name: "收纳提升", description: "通过收纳类商品减少视觉杂乱。", default_priority: 74, default_budget_ratio: 0.16, typical_item_types: ["收纳盒", "置物架", "抽屉分隔", "脏衣篮"], optional: false },
    { module_id: "decor-accent", module_name: "装饰点缀", description: "预算允许时再补一点风格点缀。", default_priority: 60, default_budget_ratio: 0.14, typical_item_types: ["装饰画", "摆件", "香薰", "挂布"], optional: true },
    { module_id: "decor-soft-upgrade", module_name: "软装升级", description: "适合希望空间更完整、更有质感的情况。", default_priority: 48, default_budget_ratio: 0.14, typical_item_types: ["床品", "窗帘", "大地毯", "靠垫"], optional: true }
  ],
  module_display_labels: {},
  module_help_text: {},
  planning_summary_template: "优先明确区域和风格，再把预算分给氛围、收纳和软装层级。",
  result_tab_labels: {}
};
