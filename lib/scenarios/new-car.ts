import { ScenarioConfig } from "@/lib/scenarios/types";

export const newCarScenario: ScenarioConfig = {
  id: "new-car",
  name: "新车选购",
  short_description: "提车初期分阶段补齐高频车用品",
  landing_title: "新车选购",
  landing_subtitle: "从提车初期的安全、整洁与便利需求出发，分阶段补齐购物清单。",
  enabled: true,
  coming_soon: false,
  input_placeholder: "例如：刚提新能源车，预算 1500，希望优先买最实用的新车用品，不考虑装饰类",
  example_prompts: [
    "刚提新能源车，预算 1500，希望优先买最实用的新车用品，不考虑装饰类",
    "新手司机，预算 2000，想兼顾安全和车内整洁",
    "只想先补齐第一阶段必需品"
  ],
  start_button_text: "开始理解需求",
  confirm_scene_title: "确认新车选购需求",
  confirm_scene_description: "先确认提车阶段、预算与偏好，再进入用品规划。",
  confirm_plan_title: "确认新车购物规划",
  confirm_plan_description: "先看模块和预算分配，再决定是否开始搜索推荐。",
  searching_status_text: "正在为你的新车首购方案逐步准备推荐商品",
  results_page_title: "新车用品推荐",
  results_intro_text: "围绕提车初期的高频需求，优先给出更值得先买的候选商品。",
  detail_button_text: "查看淘宝详情",
  cart_button_text: "加入购物车",
  product_reason_style: {
    "稳妥推荐": "适合提车初期优先入手，先补齐高频实用品。",
    "性价比推荐": "在预算内尽量兼顾功能与价格，更适合首阶段补齐。",
    "升级推荐": "更适合想一步到位提升用车体验的选择。"
  },
  product_risk_style: "当前为搜索结果摘要，未自动打开详情页，建议点开淘宝详情页确认规格与适配性",
  quick_actions: ["压缩预算到 1000", "只看必买", "去掉装饰类", "更偏实用", "更偏舒适", "我已有行车记录仪", "全部优先性价比", "换一批推荐"],
  refine_summary_template: "已按你的新车购物偏好更新规划，请确认后再继续搜索。",
  scene_brief_fields: ["vehicle_type", "budget", "priority_style", "user_stage", "avoid_items", "already_have"],
  field_labels: {
    vehicle_type: "车型",
    budget: "预算",
    priority_style: "偏好",
    user_stage: "阶段",
    avoid_items: "排除项",
    already_have: "已有物品"
  },
  field_option_sets: {
    vehicle_type: ["新能源车", "轿车", "SUV", "混动车", "MPV"],
    user_stage: ["提车初期", "第一周", "第一阶段首购", "首月补齐"],
    priority_style: ["实用优先", "舒适优先", "安全优先", "性价比优先"],
    already_have: ["行车记录仪", "车载手机支架", "应急启动电源", "车载充电器", "脚垫", "纸巾收纳"],
    avoid_items: ["装饰类", "香薰摆件", "高价升级款", "复杂安装类", "占空间收纳箱"]
  },
  base_template_modules: [
    {
      module_id: "safety-essential",
      module_name: "安全必需",
      description: "优先补足高频出行的基础安全配置。",
      default_priority: 100,
      default_budget_ratio: 0.26,
      typical_item_types: ["行车记录仪", "应急启动电源", "胎压计", "安全锤"],
      optional: false
    },
    {
      module_id: "cleaning-care",
      module_name: "清洁维护",
      description: "覆盖新车第一阶段的基础清洁和日常维护。",
      default_priority: 82,
      default_budget_ratio: 0.18,
      typical_item_types: ["洗车毛巾", "车用清洁剂", "除尘软胶", "玻璃清洁"],
      optional: false
    },
    {
      module_id: "practical-interior",
      module_name: "车内实用",
      description: "提升用车便利度，减少临时凑合。",
      default_priority: 92,
      default_budget_ratio: 0.22,
      typical_item_types: ["手机支架", "充电线", "临时停车牌", "纸巾盒"],
      optional: false
    },
    {
      module_id: "storage-organization",
      module_name: "收纳整理",
      description: "让车内物品归位，减少杂乱和异响。",
      default_priority: 74,
      default_budget_ratio: 0.14,
      typical_item_types: ["后备箱收纳箱", "座椅缝隙收纳", "挂钩", "垃圾袋"],
      optional: false
    },
    {
      module_id: "comfort-upgrade",
      module_name: "舒适升级",
      description: "兼顾长途和通勤体验的舒适性补强。",
      default_priority: 64,
      default_budget_ratio: 0.12,
      typical_item_types: ["头枕腰靠", "遮阳挡", "香薰", "坐垫"],
      optional: true
    },
    {
      module_id: "decor-ambience",
      module_name: "装饰氛围",
      description: "非必需，可在预算充足时考虑个性化氛围。",
      default_priority: 28,
      default_budget_ratio: 0.08,
      typical_item_types: ["摆件", "氛围灯", "装饰贴", "方向盘套"],
      optional: true
    }
  ],
  module_display_labels: {},
  module_help_text: {},
  planning_summary_template: "基于提车初期的使用频率和预算，优先保障安全、整洁和车内便利性。",
  result_tab_labels: {},
  adaptive_module_policy: {
    max_modules: 2,
    id_prefix: "adaptive-",
    activation_hints: [
      "儿童或婴幼儿同行：可补充儿童安全出行模块",
      "经常携带宠物：可补充宠物安全与清洁模块",
      "高频长途、自驾或夜间通勤：可补充针对性的出行保障模块",
      "有露营、骑行、滑雪等固定装载需求：可补充专属装载保护模块"
    ],
    prohibited_terms: ["保险", "金融", "贷款", "维修", "改装", "代办", "充值", "会员", "药品", "医疗"]
  }
};
