import {
  PlanQualityReview,
  PlanningModule,
  ProductCandidate,
  QuickAction,
  SceneBrief,
  ShoppingPlan
} from "@/lib/session/types";
import { getScenarioConfig } from "@/lib/scenarios";
import { searchIntentForModule } from "@/lib/agent/search-intents";

function fallbackAdaptiveModules(scene: SceneBrief): ShoppingPlan["modules"] {
  if (scene.scenario_id !== "new-car") return [];
  const notes = scene.optional_notes;
  const definitions = [
    {
      matched: /儿童|孩子|宝宝|婴儿|幼儿/.test(notes),
      module_id: "adaptive-child-safety",
      module_name: "儿童安全出行",
      description: "针对儿童同行补充乘车约束、后排防护与舒适用品。",
      typical_item_types: ["儿童安全座椅", "儿童增高垫", "后排遮阳帘"],
      keyword: `${scene.vehicle_type} 儿童安全座椅 ISOFIX 适龄`,
      rationale: "用户明确提到儿童同行，标准新车模板没有单独覆盖适龄与接口适配。"
    },
    {
      matched: /宠物|猫咪|狗狗|猫|狗/.test(notes),
      module_id: "adaptive-pet-travel",
      module_name: "宠物安全出行",
      description: "针对宠物同行补充固定、防污和车内清洁用品。",
      typical_item_types: ["宠物车载安全带", "后排宠物垫", "宠物防污垫"],
      keyword: `${scene.vehicle_type} 宠物车载安全带 后排防污垫`,
      rationale: "用户明确提到宠物同行，标准模板没有覆盖宠物固定和防污需求。"
    }
  ].filter((definition) => definition.matched).slice(0, 2);

  return definitions.map((definition, index) => ({
    module_id: definition.module_id,
    module_name: definition.module_name,
    description: definition.description,
    default_priority: 86 - index * 4,
    default_budget_ratio: 0.14,
    typical_item_types: definition.typical_item_types,
    optional: true,
    origin: "ai_adaptive",
    priority: 86 - index * 4,
    budget_allocation: Math.max(120, Math.round(scene.budget * 0.14)),
    rationale: definition.rationale,
    recommendation_strategy: "优先核对适用对象、车辆适配、安装或固定方式，再比较价格和店铺可信度。",
    search_keyword: definition.keyword,
    search_strategy: {
      primary_keyword: definition.keyword,
      alternate_keywords: definition.typical_item_types.slice(0, 3).map((item) => `${scene.vehicle_type} ${item}`),
      include_terms: definition.typical_item_types,
      exclude_terms: [...scene.avoid_items, ...scene.already_have].slice(0, 5),
      ranking_focus: ["专项需求匹配", "适配信息明确", "店铺可信度"],
      must_have_signals: definition.typical_item_types.slice(0, 3),
      reject_signals: ["适用范围不明", "安装方式不明"],
      quality_checks: ["商品图片完整", "详情链接可打开", "规格描述清楚", "店铺信息明确"],
      price_band: `建议控制在 ${Math.max(80, Math.round(scene.budget * 0.06))}-${Math.max(180, Math.round(scene.budget * 0.2))} 元区间`,
      reasoning: "使用专项品类和适配词搜索，避免混入普通车内用品。",
      failure_recovery: "首轮候选不足时，改用具体用品名称和适用对象补搜一次。"
    },
    status: "ready"
  }));
}

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
  let modules: ShoppingPlan["modules"] = template
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

      const searchKeyword = searchIntentForModule(scene, module);
      const includeTerms = module.typical_item_types.slice(0, 3);
      const excludeTerms = [...scene.avoid_items, ...scene.already_have].slice(0, 5);
      const mustHaveSignals = [module.module_name, ...includeTerms].filter(Boolean).slice(0, 4);
      const rejectSignals = excludeTerms.slice(0, 4);
      const alternateKeywords = module.typical_item_types
        .slice(1, 4)
        .map((item) => [scene.vehicle_type, item, scene.priority_style.replace("优先", "")]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim())
        .filter((item) => item && item !== searchKeyword);

      return {
        ...module,
        origin: "base_template" as const,
        priority,
        budget_allocation: Math.max(60, Math.round(scene.budget * ratio)),
        rationale: `结合“${scene.user_stage}”“${scene.priority_style}”和预算 ${scene.budget}，${module.module_name}被放在当前优先级，用来覆盖最容易马上产生价值的购买点。`,
        recommendation_strategy:
          scene.priority_style === "性价比优先"
            ? "优先筛选高销量、评价稳定、单件不过度溢价的款式，并避免把预算消耗在低频升级项上。"
            : "优先找功能明确、口碑稳定、适合当前阶段起步购买的商品，再用少量预算保留体验提升空间。",
        search_keyword: searchKeyword,
        search_strategy: {
          primary_keyword: searchKeyword,
          alternate_keywords: alternateKeywords.slice(0, 3),
          include_terms: includeTerms,
          exclude_terms: excludeTerms,
          ranking_focus:
            scene.priority_style === "性价比优先"
              ? ["价格贴近预算", "店铺可信度", "标题匹配核心品类"]
              : ["适配当前阶段", "店铺可信度", "功能明确"],
          must_have_signals: mustHaveSignals,
          reject_signals: rejectSignals,
          quality_checks: ["商品图片完整", "详情链接可打开", "店铺信息明确", "规格描述清楚"],
          price_band: `建议控制在 ${Math.max(30, Math.round(scene.budget * ratio * 0.45))}-${Math.max(80, Math.round(scene.budget * ratio * 1.15))} 元区间`,
          reasoning: `优先用“${searchKeyword}”搜索，再用${includeTerms.join("、") || module.module_name}判断是否贴合模块。`,
          failure_recovery: "如果首轮结果为空，换用更具体的品类词并保留车型/预算约束。"
        },
        status: "ready" as const
      };
    })
    .sort((a, b) => b.priority - a.priority);

  modules = [...modules, ...fallbackAdaptiveModules(scene)].sort((a, b) => b.priority - a.priority);

  const total = modules.reduce((sum, item) => sum + item.budget_allocation, 0);
  if (total > 0) {
    const targetBudget = Math.round(scene.budget);
    let allocated = 0;
    modules = modules.map((module) => {
      const budgetAllocation = Math.floor((module.budget_allocation / total) * targetBudget);
      allocated += budgetAllocation;
      return { ...module, budget_allocation: budgetAllocation };
    });
    if (modules[0]) {
      modules[0].budget_allocation += targetBudget - allocated;
    }
  }

  return {
    modules,
    overall_rationale: `以“${scene.priority_style}”为主线，先覆盖${scenario.name}的高频需求，再按预算保留少量升级空间。`,
    personalization_summary: `系统已在${scenario.name}标准模板上做模块裁剪、排序和预算微调，保持结构稳定但更贴合当前场景。`,
    execution_strategy: {
      module_sequence: modules.map((module) => module.module_id),
      budget_guardrails: [
        `总预算控制在 ${scene.budget} 元内，优先满足前两个高频模块。`,
        "单个升级类商品只有在核心模块预算未超支时再考虑。"
      ],
      tradeoffs: [
        "装饰和低频升级项默认后置，避免首购阶段分散预算。",
        "已有物品相关模块会降低优先级，避免重复购买。"
      ],
      search_notes: [
        "每个模块使用不同搜索词，先拿搜索摘要，不主动打开大量详情页。",
        "优先看店铺可信度、标题匹配度和价格是否贴近模块预算。"
      ],
      stop_rules: [
        "每个模块拿到稳妥、性价比、升级三档候选后即可停止扩搜。",
        "如果搜索结果明显触及排除项，应跳过该候选并保留预算。"
      ]
    },
    agent_directives: {
      autonomy_level: scene.priority_style === "性价比优先" ? "探索执行" : "平衡执行",
      search_depth: scene.budget >= 2000 ? "标准搜索" : "轻量搜索",
      detail_policy: "默认先读取搜索摘要，不主动打开大量详情页；只有候选风险较高或用户点击详情时再进入商品页。",
      recovery_policy: "某个模块搜索失败时，使用备用关键词补搜一次；仍失败则跳过该模块继续后续模块。",
      rerank_rules: [
        "优先保留标题和模块意图高度匹配的商品",
        "优先保留价格落在模块预算区间内的商品",
        "同档位中优先选择店铺可信度更高的商品"
      ],
      user_confirmation_points: [
        "加入购物车前必须由用户确认",
        "打开外部淘宝详情页前保持用户可控"
      ],
      safety_boundaries: [
        "不读取订单历史、地址、手机号、聊天记录等敏感数据",
        "不自动下单或支付",
        "真实工具失败时回退为产品内演示清单"
      ]
    }
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

export function mockReviewShoppingPlan(scene: SceneBrief, plan: ShoppingPlan): PlanQualityReview {
  const allocated = plan.modules.reduce((sum, module) => sum + module.budget_allocation, 0);
  const budgetDelta = Math.abs(allocated - scene.budget);
  const keywords = plan.modules
    .map((module) => module.search_keyword?.trim() || module.search_strategy?.primary_keyword?.trim())
    .filter(Boolean);
  const uniqueKeywordCount = new Set(keywords).size;
  const missingSignalModules = plan.modules.filter((module) => !module.search_strategy?.must_have_signals?.length);
  const risks: string[] = [];

  if (budgetDelta > Math.max(80, scene.budget * 0.08)) {
    risks.push("预算分配与总预算存在偏差，建议确认是否需要重新压缩或放宽。");
  }
  if (uniqueKeywordCount < keywords.length) {
    risks.push("部分模块搜索关键词相似，可能导致候选商品重复。");
  }
  if (missingSignalModules.length > 0) {
    risks.push("少数模块缺少明确验收信号，搜索结果需要更依赖人工确认。");
  }

  return {
    status: risks.length >= 2 ? "needs_attention" : "ready",
    source: "heuristic",
    summary:
      risks.length > 0
        ? "规划整体可执行，但有少量预算或搜索质量点需要在确认前留意。"
        : "规划整体稳定，可以进入搜索执行阶段。",
    strengths: [
      "已按场景模板拆成可执行模块",
      "已为模块配置差异化搜索词和预算",
      "已保留加购前用户确认边界"
    ],
    risks: risks.length ? risks : ["当前为规划级自检，实际规格仍需在商品详情页确认。"],
    improvement_suggestions:
      risks.length > 0
        ? ["如预算偏紧，优先保留前两个高频模块", "如搜索结果重复，可使用备用词补搜"]
        : ["先按当前顺序搜索，再根据候选池复盘决定是否补搜"],
    budget_comment: `当前模块预算合计 ${allocated} 元，用户预算 ${scene.budget} 元。`,
    keyword_comment: `已生成 ${uniqueKeywordCount} 组有效搜索意图。`,
    module_comment: `当前保留 ${plan.modules.length} 个模块，执行顺序由 Agent 策略控制。`,
    generated_at: new Date().toISOString()
  };
}

export function mockExplainProductFit(moduleName: string, product: Pick<ProductCandidate, "title" | "recommendation_type">) {
  return `${product.title}更适合“${moduleName}”模块中的${product.recommendation_type}档位，兼顾当前场景的实际使用频率与预算控制。`;
}
