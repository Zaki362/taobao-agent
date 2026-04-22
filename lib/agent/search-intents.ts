import { SceneBrief, ShoppingPlanModule } from "@/lib/session/types";
import { getScenarioConfig } from "@/lib/scenarios";

function pickTerms(values: string[], count = 3) {
  return values.filter(Boolean).slice(0, count).join(" ");
}

function buildScenarioPrefix(scene: SceneBrief) {
  switch (scene.scenario_id) {
    case "camping":
      return scene.vehicle_type || "露营";
    case "room-decor":
      return `${scene.vehicle_type || "房间"} ${scene.priority_style === "舒适优先" ? "温馨" : "简约"}`.trim();
    case "dorm-move-in":
      return `${scene.user_stage || "宿舍"} ${scene.vehicle_type || "入学"}`.trim();
    case "moving-setup":
      return `${scene.user_stage || "搬家"} ${scene.vehicle_type || "新居"}`.trim();
    case "new-car":
    default:
      return scene.vehicle_type.includes("车") ? scene.vehicle_type : `${scene.vehicle_type || "新车"}`;
  }
}

const MODULE_KEYWORD_OVERRIDES: Record<string, string[]> = {
  "safety-essential": ["行车记录仪", "应急启动电源", "胎压计"],
  "cleaning-care": ["洗车毛巾", "车内清洁", "除尘用品"],
  "practical-interior": ["车载手机支架", "充电线", "停车牌"],
  "storage-organization": ["后备箱收纳箱", "座椅缝隙收纳", "车载挂钩"],
  "comfort-upgrade": ["头枕腰靠", "遮阳挡", "通勤舒适"],
  "decor-ambience": ["车载香薰", "氛围灯", "车内摆件"],
  "camp-core": ["帐篷", "天幕", "折叠椅"],
  "camp-sleep": ["睡袋", "防潮垫", "充气垫"],
  "camp-light-power": ["露营灯", "头灯", "户外电源"],
  "camp-cooking": ["卡式炉", "锅具", "餐具"],
  "camp-storage": ["露营收纳箱", "折叠推车", "装备袋"],
  "camp-atmosphere": ["露营串灯", "地毯", "氛围装饰"],
  "decor-lighting": ["台灯", "氛围灯", "小夜灯"],
  "decor-bedside": ["床边地毯", "边几", "床头收纳"],
  "decor-desk": ["桌面收纳", "桌垫", "小摆件"],
  "decor-storage": ["收纳盒", "置物架", "抽屉分隔"],
  "decor-accent": ["装饰画", "香薰灯", "摆件"],
  "decor-soft-upgrade": ["床品", "窗帘", "抱枕"],
  "dorm-bedding": ["床垫", "枕头", "宿舍三件套"],
  "dorm-study": ["小台灯", "桌面收纳", "书立"],
  "dorm-storage": ["收纳箱", "挂钩", "脏衣篮"],
  "dorm-cleaning": ["洗漱篮", "毛巾", "清洁刷"],
  "dorm-daily": ["衣架", "垃圾桶", "日用品"],
  "dorm-comfort": ["坐垫", "床帘", "小风扇"],
  "move-cleaning": ["清洁套装", "拖把", "垃圾袋"],
  "move-kitchen": ["厨房置物架", "锅具", "餐具"],
  "move-bathroom": ["浴室置物架", "地垫", "洗漱收纳"],
  "move-storage": ["收纳箱", "抽屉分隔", "置物篮"],
  "move-daily": ["垃圾桶", "衣架", "地垫"],
  "move-comfort": ["床边灯", "抱枕", "香薰"]
};

export function searchIntentForModule(
  scene: SceneBrief,
  module: Pick<ShoppingPlanModule, "module_id" | "module_name" | "typical_item_types">
) {
  const scenario = getScenarioConfig(scene.scenario_id);
  const prefix = buildScenarioPrefix(scene);
  const overrideTerms = MODULE_KEYWORD_OVERRIDES[module.module_id];
  const fallbackTerms = module.typical_item_types.slice(0, 3);
  const terms = overrideTerms?.length ? overrideTerms : fallbackTerms;
  const disambiguator =
    scene.priority_style === "性价比优先"
      ? "高性价比"
      : scene.priority_style === "舒适优先"
        ? "舒适"
        : scene.priority_style === "安全优先"
          ? "稳妥"
          : "";

  return [prefix, pickTerms(terms), disambiguator, scenario.name]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
