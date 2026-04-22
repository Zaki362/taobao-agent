import { PlanningModule } from "@/lib/session/types";

export const NEW_CAR_SETUP_TEMPLATE: PlanningModule[] = [
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
];
