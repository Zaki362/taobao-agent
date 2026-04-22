import {
  PlanningModule,
  ProductCandidate,
  QuickAction,
  SceneBrief,
  ShoppingPlan
} from "@/lib/session/types";
import { getScenarioConfig } from "@/lib/scenarios";

export function mockParseScene(input: string, scenarioId: SceneBrief["scenario_id"] = "new-car"): SceneBrief {
  const scenario = getScenarioConfig(scenarioId);
  const budgetMatch = input.match(/(\d{3,5})/);
  const budget = budgetMatch ? Number(budgetMatch[1]) : 1500;
  const practical = input.includes("实用");
  const comfort = input.includes("舒适");
  const safety = input.includes("安全");
  const cost = input.includes("性价比");
  const style = practical
    ? "实用优先"
    : comfort
      ? "舒适优先"
      : safety
        ? "安全优先"
        : cost
          ? "性价比优先"
          : "实用优先";

  return {
    scenario_id: scenarioId,
    scene_type: scenario.name,
    vehicle_type:
      scenario.field_option_sets.vehicle_type?.find((item) => input.includes(item.replace("及以上", ""))) ??
      scenario.field_option_sets.vehicle_type?.[0] ??
      "默认场景",
    user_stage:
      scenario.field_option_sets.user_stage?.find((item) => input.includes(item.replace("阶段", ""))) ??
      scenario.field_option_sets.user_stage?.[0] ??
      "默认阶段",
    budget,
    priority_style: style,
    already_have: scenario.field_option_sets.already_have?.filter((item) => input.includes(item)) ?? [],
    avoid_items: scenario.field_option_sets.avoid_items?.filter((item) => input.includes(item.replace("不", "")) || input.includes(item)) ?? [],
    optional_notes: input
  };
}

export function mockPersonalizeTemplate(
  scene: SceneBrief,
  template: PlanningModule[]
): ShoppingPlan {
  const scenario = getScenarioConfig(scene.scenario_id);
  let modules = template
    .filter((module) => !(scene.avoid_items.some((item) => /装饰|氛围|软装/.test(item)) && /decor|ambience|atmosphere|accent/.test(module.module_id)))
    .filter((module) => !(scene.avoid_items.some((item) => /舒适|过夜|大件/.test(item)) && /comfort|sleep/.test(module.module_id)))
    .map((module) => {
      let priority = module.default_priority;
      let ratio = module.default_budget_ratio;

      if (scene.priority_style === "实用优先" && /(practical|storage|daily|core|clean|study|kitchen|bathroom)/.test(module.module_id)) {
        priority += 12;
        ratio += 0.05;
      }

      if (scene.priority_style === "舒适优先" && /(comfort|sleep|bed|soft|bedding)/.test(module.module_id)) {
        priority += 16;
        ratio += 0.06;
      }

      if (scene.priority_style === "安全优先" && /(safety|light|clean|bathroom)/.test(module.module_id)) {
        priority += 15;
        ratio += 0.05;
      }

      if (scene.priority_style === "性价比优先") {
        ratio -= 0.01;
      }

      if (scene.already_have.length > 0 && module.typical_item_types.some((item) => scene.already_have.includes(item))) {
        priority -= 8;
        ratio -= 0.04;
      }

      return {
        ...module,
        priority,
        budget_allocation: Math.max(60, Math.round(scene.budget * ratio)),
        rationale: `${module.module_name}围绕${scene.priority_style}进行调整，优先覆盖当前场景里最容易立刻使用到的用品。`,
        recommendation_strategy:
          scene.priority_style === "性价比优先"
            ? "优先筛选高销量、评价稳定、单件不过度溢价的款式。"
            : "优先找功能明确、口碑稳定、适合当前场景起步阶段购买的商品。",
        status: "ready" as const
      };
    })
    .sort((a, b) => b.priority - a.priority);

  const total = modules.reduce((sum, item) => sum + item.budget_allocation, 0);
  const delta = scene.budget - total;
  if (modules[0]) {
    modules[0].budget_allocation += delta;
  }

  return {
    modules,
    overall_rationale: `以“${scene.priority_style}”为主线，先覆盖${scenario.name}的高频需求，再按预算保留少量升级空间。`,
    personalization_summary: `DeepSeek 负责在${scenario.name}标准模板上做模块裁剪、排序和预算微调，保持结构稳定但更贴合当前场景。`
  };
}

export function mockRefineScene(scene: SceneBrief, action: QuickAction): SceneBrief {
  if (action === "压缩预算到 1000" || action === "压缩预算") {
    return { ...scene, budget: 1000 };
  }
  if (action === "去掉装饰类" || action === "去掉氛围类" || action === "去掉大件" || action === "去掉软装类") {
    return { ...scene, avoid_items: Array.from(new Set([...scene.avoid_items, action.replace("去掉", "")])) };
  }
  if (action === "更偏实用") {
    return { ...scene, priority_style: "实用优先" };
  }
  if (action === "更偏舒适") {
    return { ...scene, priority_style: "舒适优先" };
  }
  if (action.startsWith("我已有")) {
    return { ...scene, already_have: Array.from(new Set([...scene.already_have, action.replace("我已有", "")])) };
  }
  if (action === "全部优先性价比") {
    return { ...scene, priority_style: "性价比优先" };
  }
  if (action === "只看必买" || action === "只看基础装备" || action === "只看氛围提升" || action === "只看必需品" || action === "只看基础起步") {
    return { ...scene, avoid_items: Array.from(new Set([...scene.avoid_items, "装饰类", "舒适升级"])) };
  }
  if (action === "更偏轻量化" || action === "更偏简约" || action === "更偏收纳" || action === "更偏清洁") {
    return { ...scene, priority_style: "实用优先" };
  }
  if (action === "更偏温馨") {
    return { ...scene, priority_style: "舒适优先" };
  }
  if (action === "不考虑做饭" || action === "不想打孔安装" || action === "不买电器" || action === "不买大件") {
    return { ...scene, avoid_items: Array.from(new Set([...scene.avoid_items, action])) };
  }
  return scene;
}

export function mockExplainProductFit(moduleName: string, product: Pick<ProductCandidate, "title" | "recommendation_type">) {
  return `${product.title}更适合“${moduleName}”模块中的${product.recommendation_type}档位，兼顾当前场景的实际使用频率与预算控制。`;
}
