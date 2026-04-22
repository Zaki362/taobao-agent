import { ScenarioConfig } from "@/lib/scenarios/types";

export const campingScenario: ScenarioConfig = {
  id: "camping",
  name: "露营准备",
  short_description: "按露营类型与人数补齐基础装备",
  landing_title: "露营准备",
  landing_subtitle: "围绕人数、露营类型和舒适度目标，分阶段准备装备清单。",
  enabled: true,
  coming_soon: false,
  input_placeholder: "例如：双人露营，预算 2000，第一次尝试，希望先买最基础实用的装备",
  example_prompts: [
    "双人露营，预算 2000，第一次尝试，希望先买最基础实用的装备",
    "自驾露营，预算 3000，优先考虑过夜舒适度",
    "只准备白天轻露营，不考虑过夜装备"
  ],
  start_button_text: "开始整理露营需求",
  confirm_scene_title: "确认露营准备需求",
  confirm_scene_description: "先确认露营人数、类型和已有装备，再进入装备规划。",
  confirm_plan_title: "确认露营装备规划",
  confirm_plan_description: "先看模块与预算，再开始搜索候选装备。",
  searching_status_text: "正在为你的露营准备方案逐步补齐候选装备",
  results_page_title: "露营装备推荐",
  results_intro_text: "优先给出更适合当前人数、露营类型和预算的基础装备。",
  detail_button_text: "查看淘宝详情",
  cart_button_text: "加入购物车",
  product_reason_style: {
    "稳妥推荐": "适合第一次露营优先入手，覆盖基础使用场景。",
    "性价比推荐": "更适合控制预算，同时保证露营体验不失衡。",
    "升级推荐": "适合希望在舒适度或完成度上一步到位的选择。"
  },
  product_risk_style: "当前为搜索结果摘要，建议点开淘宝详情页确认尺寸、搭建方式与适用户外场景",
  quick_actions: ["压缩预算", "只看基础装备", "去掉氛围类", "更偏轻量化", "更偏舒适", "我已有帐篷", "不考虑做饭", "换一批推荐"],
  refine_summary_template: "已根据你的露营偏好更新装备规划，请确认后再开始搜索。",
  scene_brief_fields: ["vehicle_type", "budget", "priority_style", "user_stage", "avoid_items", "already_have"],
  field_labels: {
    vehicle_type: "出行人数",
    budget: "预算",
    priority_style: "偏好",
    user_stage: "露营类型",
    avoid_items: "排除项",
    already_have: "已有物品"
  },
  field_option_sets: {
    vehicle_type: ["单人", "双人", "三人及以上", "家庭出行"],
    user_stage: ["白天轻露营", "过夜露营", "自驾露营", "第一次尝试"],
    priority_style: ["实用优先", "舒适优先", "安全优先", "性价比优先"],
    already_have: ["帐篷", "天幕", "折叠椅", "睡袋", "露营灯", "露营推车"],
    avoid_items: ["不买大件", "不考虑做饭", "不考虑过夜", "不买氛围灯", "不买桌椅套装"]
  },
  base_template_modules: [
    { module_id: "camp-core", module_name: "核心装备", description: "优先补齐露营起步阶段最不可缺的装备。", default_priority: 100, default_budget_ratio: 0.28, typical_item_types: ["帐篷", "天幕", "折叠桌", "折叠椅"], optional: false },
    { module_id: "camp-sleep", module_name: "休息睡眠", description: "围绕过夜或久坐场景补足休息体验。", default_priority: 84, default_budget_ratio: 0.2, typical_item_types: ["睡袋", "充气垫", "枕头", "防潮垫"], optional: false },
    { module_id: "camp-light-power", module_name: "照明与电源", description: "保证夜间照明和基础供电。", default_priority: 78, default_budget_ratio: 0.14, typical_item_types: ["露营灯", "头灯", "户外电源", "充电灯串"], optional: false },
    { module_id: "camp-cooking", module_name: "炊具餐食", description: "适合有做饭或热食需求的场景。", default_priority: 66, default_budget_ratio: 0.16, typical_item_types: ["卡式炉", "锅具", "餐具", "保温箱"], optional: true },
    { module_id: "camp-storage", module_name: "收纳搬运", description: "减少搬运和取物时的混乱。", default_priority: 70, default_budget_ratio: 0.12, typical_item_types: ["收纳箱", "折叠推车", "装备袋", "挂物架"], optional: false },
    { module_id: "camp-atmosphere", module_name: "氛围加分", description: "预算充足时再考虑空间氛围和拍照感。", default_priority: 32, default_budget_ratio: 0.1, typical_item_types: ["串灯", "地毯", "装饰旗", "氛围摆件"], optional: true }
  ],
  module_display_labels: {},
  module_help_text: {},
  planning_summary_template: "优先满足露营基础完成度，再按舒适度和氛围感做预算分配。",
  result_tab_labels: {}
};
