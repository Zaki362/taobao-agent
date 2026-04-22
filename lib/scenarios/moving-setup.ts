import { ScenarioConfig } from "@/lib/scenarios/types";

export const movingSetupScenario: ScenarioConfig = {
  id: "moving-setup",
  name: "搬家置办",
  short_description: "围绕基础居住需求整理搬家起步清单",
  landing_title: "搬家置办",
  landing_subtitle: "从清洁、厨房、卫浴和收纳出发，优先补齐搬家初期高频用品。",
  enabled: true,
  coming_soon: false,
  input_placeholder: "例如：刚搬进一居室，预算 2000，优先买清洁和基础收纳用品",
  example_prompts: [
    "刚搬进一居室，预算 2000，优先买清洁和基础收纳用品",
    "小户型租房，预算 1000，先把厨房和卫生间补齐",
    "想先买高频日用品，不做大件升级"
  ],
  start_button_text: "开始整理搬家清单",
  confirm_scene_title: "确认搬家置办需求",
  confirm_scene_description: "先确认居住类型、优先区域和已有用品，再进入置办规划。",
  confirm_plan_title: "确认搬家购物规划",
  confirm_plan_description: "先确认分区和预算，再开始搜索具体商品。",
  searching_status_text: "正在为你的搬家起步清单准备候选商品",
  results_page_title: "搬家基础置办推荐",
  results_intro_text: "围绕新居起步阶段的高频使用场景，优先补齐真正会立刻用到的用品。",
  detail_button_text: "查看淘宝详情",
  cart_button_text: "加入购物车",
  product_reason_style: {
    "稳妥推荐": "适合搬家初期高频使用，先把基础生活撑起来。",
    "性价比推荐": "更适合控制预算下快速补齐刚需。",
    "升级推荐": "适合在基础需求补齐后进一步提升使用体验。"
  },
  product_risk_style: "当前为搜索结果摘要，建议点开淘宝详情页确认尺寸、材质和居住场景适配性",
  quick_actions: ["压缩预算", "只看基础起步", "去掉软装类", "更偏收纳", "更偏清洁", "我已有厨房用品", "不买大件", "换一批推荐"],
  refine_summary_template: "已按你的搬家偏好更新规划，请确认后再开始搜索。",
  scene_brief_fields: ["vehicle_type", "budget", "priority_style", "user_stage", "avoid_items", "already_have"],
  field_labels: {
    vehicle_type: "优先区域",
    budget: "预算",
    priority_style: "偏好",
    user_stage: "居住类型",
    avoid_items: "排除项",
    already_have: "已有物品"
  },
  field_option_sets: {
    vehicle_type: ["厨房", "卫生间", "客厅", "卧室", "清洁"],
    user_stage: ["一居室", "合租", "单间", "小户型"],
    priority_style: ["实用优先", "舒适优先", "安全优先", "性价比优先"],
    already_have: ["厨房用品", "清洁工具", "收纳箱", "垃圾桶", "浴室置物架", "拖把"],
    avoid_items: ["不买家具", "不买大件", "不做软装", "不买电器", "不买落地置物架"]
  },
  base_template_modules: [
    { module_id: "move-cleaning", module_name: "基础清洁", description: "搬家初期优先把清洁用品补齐。", default_priority: 100, default_budget_ratio: 0.2, typical_item_types: ["拖把", "抹布", "清洁剂", "垃圾袋"], optional: false },
    { module_id: "move-kitchen", module_name: "厨房起步", description: "适合先补齐做饭和收纳起步用品。", default_priority: 88, default_budget_ratio: 0.2, typical_item_types: ["锅具", "餐具", "置物架", "调味收纳"], optional: false },
    { module_id: "move-bathroom", module_name: "卫生间必需", description: "优先解决洗护和卫浴起步需求。", default_priority: 82, default_budget_ratio: 0.16, typical_item_types: ["浴室置物架", "地垫", "马桶刷", "洗漱收纳"], optional: false },
    { module_id: "move-storage", module_name: "收纳整理", description: "帮助新空间尽快归位，减少凌乱。", default_priority: 90, default_budget_ratio: 0.18, typical_item_types: ["收纳箱", "抽屉分隔", "置物篮", "挂钩"], optional: false },
    { module_id: "move-daily", module_name: "高频日用", description: "补齐每天都可能用到的小件用品。", default_priority: 74, default_budget_ratio: 0.16, typical_item_types: ["垃圾桶", "衣架", "纸巾盒", "地垫"], optional: false },
    { module_id: "move-comfort", module_name: "居住舒适", description: "预算允许时再补舒适类商品。", default_priority: 44, default_budget_ratio: 0.1, typical_item_types: ["床边灯", "软垫", "香薰", "抱枕"], optional: true }
  ],
  module_display_labels: {},
  module_help_text: {},
  planning_summary_template: "优先把新居基础功能补齐，再按收纳和舒适度逐步完善。",
  result_tab_labels: {}
};
