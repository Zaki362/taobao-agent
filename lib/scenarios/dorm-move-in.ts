import { ScenarioConfig } from "@/lib/scenarios/types";

export const dormMoveInScenario: ScenarioConfig = {
  id: "dorm-move-in",
  name: "宿舍入学",
  short_description: "围绕入学阶段补齐宿舍高频生活用品",
  landing_title: "宿舍入学",
  landing_subtitle: "从床上用品、桌面学习、洗护清洁和收纳出发，补齐入学清单。",
  enabled: true,
  coming_soon: false,
  input_placeholder: "例如：大一新生入住宿舍，预算 1000，希望先买实用必需品",
  example_prompts: [
    "大一新生入住宿舍，预算 1000，希望先买实用必需品",
    "女生宿舍，预算 1500，想兼顾收纳和生活舒适度",
    "只补齐床上和桌面用品"
  ],
  start_button_text: "开始整理宿舍清单",
  confirm_scene_title: "确认宿舍入学需求",
  confirm_scene_description: "先确认入学阶段、关注重点和已有用品，再进入宿舍清单规划。",
  confirm_plan_title: "确认宿舍购物规划",
  confirm_plan_description: "先确认模块和预算，再开始搜索具体商品。",
  searching_status_text: "正在为你的宿舍入学清单准备候选商品",
  results_page_title: "宿舍入学推荐",
  results_intro_text: "优先补齐入学阶段高频且真实需要用到的宿舍用品。",
  detail_button_text: "查看淘宝详情",
  cart_button_text: "加入购物车",
  product_reason_style: {
    "稳妥推荐": "适合新生阶段优先补齐，高频使用更明确。",
    "性价比推荐": "更适合在预算内完成宿舍起步清单。",
    "升级推荐": "适合在基础需求满足后提升舒适和体验。"
  },
  product_risk_style: "当前为搜索结果摘要，建议点开淘宝详情页确认尺寸、材质和宿舍场景适用性",
  quick_actions: ["压缩预算", "只看必需品", "去掉装饰类", "更偏收纳", "更偏舒适", "我已有床上用品", "不买电器", "换一批推荐"],
  refine_summary_template: "已按你的宿舍需求更新规划，请确认后再开始搜索。",
  scene_brief_fields: ["vehicle_type", "budget", "priority_style", "user_stage", "avoid_items", "already_have"],
  field_labels: {
    vehicle_type: "关注重点",
    budget: "预算",
    priority_style: "偏好",
    user_stage: "入学阶段",
    avoid_items: "排除项",
    already_have: "已有物品"
  },
  field_option_sets: {
    vehicle_type: ["收纳", "床上用品", "洗护", "桌面学习", "生活舒适"],
    user_stage: ["首次入学", "开学补齐", "局部升级"],
    priority_style: ["实用优先", "舒适优先", "安全优先", "性价比优先"],
    already_have: ["床上用品", "台灯", "收纳箱", "洗漱篮", "挂钩", "小风扇"],
    avoid_items: ["不买大件", "不买电器", "不买装饰", "不买床帘", "不买桌面增高架"]
  },
  base_template_modules: [
    { module_id: "dorm-bedding", module_name: "床上用品", description: "优先补齐宿舍睡眠相关用品。", default_priority: 100, default_budget_ratio: 0.24, typical_item_types: ["床垫", "枕头", "被子", "三件套"], optional: false },
    { module_id: "dorm-study", module_name: "桌面学习", description: "围绕书桌和学习场景提升使用效率。", default_priority: 84, default_budget_ratio: 0.18, typical_item_types: ["小台灯", "桌面收纳", "书立", "桌垫"], optional: false },
    { module_id: "dorm-storage", module_name: "收纳整理", description: "减少宿舍杂乱，方便日常取用。", default_priority: 90, default_budget_ratio: 0.18, typical_item_types: ["收纳箱", "挂钩", "脏衣篮", "抽屉分隔"], optional: false },
    { module_id: "dorm-cleaning", module_name: "洗护清洁", description: "把洗漱和清洁用品补齐。", default_priority: 76, default_budget_ratio: 0.14, typical_item_types: ["洗漱篮", "拖鞋", "毛巾", "清洁刷"], optional: false },
    { module_id: "dorm-daily", module_name: "日常生活", description: "覆盖宿舍高频生活用品。", default_priority: 72, default_budget_ratio: 0.16, typical_item_types: ["水壶", "衣架", "纸巾盒", "垃圾桶"], optional: false },
    { module_id: "dorm-comfort", module_name: "舒适补充", description: "预算允许时补一点舒适度用品。", default_priority: 46, default_budget_ratio: 0.1, typical_item_types: ["坐垫", "床帘", "小风扇", "靠垫"], optional: true }
  ],
  module_display_labels: {},
  module_help_text: {},
  planning_summary_template: "优先补齐宿舍起步期的高频用品，再按舒适度和个人使用习惯做细化。",
  result_tab_labels: {}
};
