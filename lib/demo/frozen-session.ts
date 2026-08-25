import snapshot from "@/fixtures/interview-demo/taobao-snapshot-2026-08-08.json";
import { getScenarioConfig } from "@/lib/scenarios";
import type {
  HostedExecutionTask,
  MarketFeedback,
  ModuleMarketSignal,
  PlanningModule,
  ProductCandidate,
  RecommendationType,
  ScenarioId,
  SessionState,
  ShoppingPlanModule
} from "@/lib/session/types";

export const DEMO_CAPTURED_AT = "2026-08-08T14:33:55+08:00";
export const DEMO_DEFAULT_INPUT =
  "刚提新能源车，预算 1500 元，优先实用和安全，周末会带孩子长途出行，不考虑装饰类。";
export const DEMO_MODULE_IDS = [
  "safety-essential",
  "practical-interior",
  "cleaning-care",
  "storage-organization"
] as const;

type DemoModuleId = (typeof DEMO_MODULE_IDS)[number];

type SnapshotProduct = {
  product_id: string;
  title: string;
  price: number;
  shop_name: string;
  image_url: string;
};

type DemoModuleDefinition = {
  module: PlanningModule;
  priority: number;
  budget_weight: number;
  rationale: string;
  keyword: string;
  alternate_keywords: string[];
  ranking_focus: string[];
};

const DEMO_SESSION_ID = "public-demo-new-car-2026-08-08";
const DEMO_WORKFLOW_RUN_ID = "public-demo-workflow-2026-08-08";

const SOURCE_MODULES = snapshot.modules as Record<string, SnapshotProduct[]>;

const MODULE_DEFINITIONS: Record<DemoModuleId, DemoModuleDefinition> = {
  "safety-essential": {
    module: {
      module_id: "safety-essential",
      module_name: "安全必需",
      description: "优先补足高频出行的基础安全配置。",
      default_priority: 100,
      default_budget_ratio: 0.26,
      typical_item_types: ["应急启动电源", "车载充气泵", "胎压计", "安全锤"],
      optional: false
    },
    priority: 100,
    budget_weight: 0.26,
    rationale: "儿童同行和周末长途会放大突发故障成本，因此先覆盖基础应急能力。",
    keyword: "新能源车 应急启动电源 充气泵",
    alternate_keywords: ["新能源车 搭电宝", "汽车 应急电源 强启动", "车载充气泵 搭电一体机"],
    ranking_focus: ["长途应急覆盖", "功能组合完整", "店铺可信度"]
  },
  "practical-interior": {
    module: {
      module_id: "practical-interior",
      module_name: "车内实用",
      description: "提升用车便利度，减少临时凑合。",
      default_priority: 92,
      default_budget_ratio: 0.22,
      typical_item_types: ["手机支架", "充电线", "临时停车牌", "纸巾盒"],
      optional: false
    },
    priority: 94,
    budget_weight: 0.22,
    rationale: "导航与临时停车是高频任务，优先解决稳定支撑和取用效率。",
    keyword: "新能源车 手机支架 磁吸",
    alternate_keywords: ["新能源汽车 中控屏 手机支架", "车载手机支架 真空吸附", "大屏车机 磁吸支架"],
    ranking_focus: ["新能源车型适配", "支撑稳定性", "拆装效率"]
  },
  "cleaning-care": {
    module: {
      module_id: "cleaning-care",
      module_name: "清洁维护",
      description: "覆盖新车第一阶段的基础清洁和日常维护。",
      default_priority: 82,
      default_budget_ratio: 0.18,
      typical_item_types: ["洗车毛巾", "车用清洁剂", "除尘软胶", "玻璃清洁"],
      optional: false
    },
    priority: 82,
    budget_weight: 0.18,
    rationale: "覆盖提车第一阶段的基础清洁，避免被低频装饰品挤占预算。",
    keyword: "新车 洗车毛巾 内饰清洁",
    alternate_keywords: ["汽车清洁工具 软毛", "擦车毛巾 吸水 不掉毛", "汽车内饰清洁 毛巾"],
    ranking_focus: ["日常使用频率", "清洁材质安全", "价格合理"]
  },
  "storage-organization": {
    module: {
      module_id: "storage-organization",
      module_name: "收纳整理",
      description: "让车内物品归位，减少杂乱和异响。",
      default_priority: 74,
      default_budget_ratio: 0.14,
      typical_item_types: ["后备箱收纳箱", "座椅缝隙收纳", "挂钩", "垃圾袋"],
      optional: false
    },
    priority: 74,
    budget_weight: 0.14,
    rationale: "有明确后备箱使用场景再购买，保留预算余量并减少闲置。",
    keyword: "汽车 后备箱收纳箱",
    alternate_keywords: ["车载尾箱 储物箱", "汽车后备箱 分区收纳", "车内收纳盒 通用"],
    ranking_focus: ["空间利用率", "车型与尺寸适配", "收纳结构"]
  }
};

const PRODUCT_REASONS: Record<DemoModuleId, string[]> = {
  "safety-essential": [
    "长途出行时同时覆盖搭电与补气两类高频应急需求，价格处在安全模块预算内，减少重复购买。",
    "功能组合完整、价格克制，适合希望把更多预算留给其他模块的方案。",
    "品牌与基础功能更稳妥，适合更重视耐用性、愿意提高安全预算的用户。"
  ],
  "practical-interior": [
    "真空吸附与磁吸结构更适合新能源车大屏导航场景，兼顾稳定和日常拆装效率。",
    "适配常见新能源车型，价格更低，适合优先控制第一阶段总预算。",
    "结构简单、价格最低，适合作为低成本试用方案，但购买前仍需确认中控台材质。"
  ],
  "cleaning-care": [
    "覆盖车身与车内基础清洁，适合新车第一阶段建立完整工具，而不是零散补购。",
    "吸水、不易掉毛，价格低且使用频率高，是更聚焦日常维护的选择。",
    "双面加厚并兼顾内饰，适合已有洗车工具、只缺基础毛巾的用户。"
  ],
  "storage-organization": [
    "通用后备箱收纳结构能快速解决杂物滚动和分类问题，价格处于按需模块预算下沿。",
    "更强调车型适配与分区收纳，适合确认尺寸后追求规整度的用户。",
    "价格更低、用途通用，适合先验证收纳需求再决定是否升级。"
  ]
};

const PRODUCT_HIGHLIGHTS: Record<DemoModuleId, string[][]> = {
  "safety-essential": [["搭电 + 充气", "长途应急"], ["组合功能", "预算友好"], ["品牌选择", "耐用优先"]],
  "practical-interior": [["真空吸附", "磁吸导航"], ["新能源适配", "合金结构"], ["低成本", "通用大屏"]],
  "cleaning-care": [["软毛清洁", "车家两用"], ["强吸水", "不易掉毛"], ["双面加厚", "内饰可用"]],
  "storage-organization": [["后备箱收纳", "通用车型"], ["车型适配", "分区储物"], ["轻量收纳", "价格更低"]]
};

const PRODUCT_IMAGE_PATHS: Record<DemoModuleId, string[]> = {
  "safety-essential": ["/demo-products/safety-1.webp", "/demo-products/safety-2.webp", "/demo-products/safety-3.webp"],
  "practical-interior": ["/demo-products/practical-1.webp", "/demo-products/practical-2.webp", "/demo-products/practical-3.webp"],
  "cleaning-care": ["/demo-products/cleaning-1.webp", "/demo-products/cleaning-2.webp", "/demo-products/cleaning-3.webp"],
  "storage-organization": ["/demo-products/storage-1.webp", "/demo-products/storage-2.webp", "/demo-products/storage-3.webp"]
};

const RECOMMENDATION_TYPES: RecommendationType[] = ["稳妥推荐", "性价比推荐", "升级推荐"];

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizedBudget(rawInput: string, budget?: number) {
  if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) {
    return Math.round(budget);
  }
  const parsed = rawInput.match(/(?:预算\s*)?(\d{3,5})\s*元?/);
  return parsed ? Number(parsed[1]) : 1500;
}

function allocateModuleBudgets(totalBudget: number) {
  const totalWeight = DEMO_MODULE_IDS.reduce(
    (sum, moduleId) => sum + MODULE_DEFINITIONS[moduleId].budget_weight,
    0
  );
  const allocations = Object.fromEntries(
    DEMO_MODULE_IDS.map((moduleId) => [
      moduleId,
      Math.floor(totalBudget * MODULE_DEFINITIONS[moduleId].budget_weight / totalWeight)
    ])
  ) as Record<DemoModuleId, number>;
  const allocated = DEMO_MODULE_IDS.reduce((sum, moduleId) => sum + allocations[moduleId], 0);
  allocations[DEMO_MODULE_IDS[0]] += totalBudget - allocated;
  return allocations;
}

function buildPlanModules(totalBudget: number): ShoppingPlanModule[] {
  const allocations = allocateModuleBudgets(totalBudget);
  return DEMO_MODULE_IDS.map((moduleId) => {
    const definition = MODULE_DEFINITIONS[moduleId];
    const moduleBudget = allocations[moduleId];
    return {
      ...definition.module,
      typical_item_types: [...definition.module.typical_item_types],
      origin: "base_template",
      priority: definition.priority,
      budget_allocation: moduleBudget,
      rationale: definition.rationale,
      recommendation_strategy: "先核对适配性与高频使用价值，再按稳妥、性价比、升级三档保留可比较候选。",
      search_keyword: definition.keyword,
      search_strategy: {
        primary_keyword: definition.keyword,
        alternate_keywords: [...definition.alternate_keywords],
        include_terms: definition.module.typical_item_types.slice(0, 3),
        exclude_terms: ["装饰类", "香薰摆件", "高价升级款"],
        ranking_focus: [...definition.ranking_focus],
        must_have_signals: [definition.module.module_name, ...definition.module.typical_item_types.slice(0, 2)],
        reject_signals: ["适配信息不明", "规格描述不清", "装饰类"],
        quality_checks: ["商品图片完整", "店铺信息明确", "标题匹配模块", "规格需在详情页复核"],
        price_band: `建议控制在 ${Math.max(30, Math.round(moduleBudget * 0.2))}-${Math.max(80, Math.round(moduleBudget * 0.75))} 元区间`,
        reasoning: `围绕“${definition.keyword}”筛选与${definition.module.module_name}直接相关的商品。`,
        failure_recovery: "如果首轮候选不足，只切换到备用关键词补搜一次，不扩大到无关品类。"
      },
      status: "ready"
    };
  });
}

function buildProducts(): Record<string, ProductCandidate[]> {
  return Object.fromEntries(DEMO_MODULE_IDS.map((moduleId) => {
    const products = (SOURCE_MODULES[moduleId] ?? []).slice(0, 3).map((product, index): ProductCandidate => {
      const recommendationType = RECOMMENDATION_TYPES[index] ?? "升级推荐";
      const fitReason = PRODUCT_REASONS[moduleId][index] ?? "符合当前模块的使用频率与预算要求。";
      const detailUrl = `https://item.taobao.com/item.htm?id=${product.product_id}`;
      return {
        product_id: product.product_id,
        title: product.title,
        price: product.price,
        source: "淘宝历史快照",
        shop_name: product.shop_name,
        image_url: PRODUCT_IMAGE_PATHS[moduleId][index] ?? product.image_url,
        detail_url: detailUrl,
        shop_badges: product.shop_name.includes("旗舰店") ? ["旗舰店"] : [],
        highlights: [...(PRODUCT_HIGHLIGHTS[moduleId][index] ?? [])],
        risk_notes: [
          index === 0
            ? "冻结快照未实时核验规格与库存，购买前仍需确认车型或具体 SKU。"
            : "备选仅用于比较，购买前需重新核对详情页、价格与适配性。"
        ],
        fit_reason: fitReason,
        recommendation_type: recommendationType,
        module_id: moduleId,
        detail_evidence: {
          schema: "scenecart.taobao-mcp-product-detail-evidence/v1",
          source: "taobao-mcp",
          status: "unavailable",
          tool: "navigate_to_url+read_page_content",
          tools_used: [],
          source_app: "Taobao Desktop（历史快照）",
          job_id: `frozen-detail-${product.product_id}`,
          search_job_id: `frozen-search-${moduleId}`,
          module_id: moduleId,
          workflow_run_id: DEMO_WORKFLOW_RUN_ID,
          product_id: product.product_id,
          detail_url: detailUrl,
          captured_at: DEMO_CAPTURED_AT,
          unavailable_reason: "公开 Demo 只读取脱敏历史快照，不访问实时商品详情。",
          recommendation_reason: fitReason
        }
      };
    });
    return [moduleId, products];
  }));
}

function median(values: number[]) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? roundMoney((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

function buildMarketFeedback(
  modules: ShoppingPlanModule[],
  candidatesByModule: Record<string, ProductCandidate[]>
): MarketFeedback {
  const signals = modules.map((module): ModuleMarketSignal => {
    const candidates = candidatesByModule[module.module_id] ?? [];
    const prices = candidates
      .map((candidate) => candidate.price)
      .filter((price) => Number.isFinite(price) && price > 0)
      .sort((a, b) => a - b);
    const withinBudget = prices.filter((price) => price <= module.budget_allocation);
    const medianPrice = median(prices);
    const referencePrice = median(withinBudget) ?? prices[0];
    const pressure: ModuleMarketSignal["pressure"] = prices.length === 0
      ? "unobserved"
      : prices[0] > module.budget_allocation
        ? "over_budget"
        : withinBudget.length / prices.length < 0.5 || (medianPrice ?? 0) > module.budget_allocation
          ? "tight"
          : (medianPrice ?? 0) <= module.budget_allocation * 0.65
            ? "opportunity"
            : "healthy";
    const summary = pressure === "unobserved"
      ? `「${module.module_name}」尚未读取冻结候选，暂不形成价格判断。`
      : pressure === "opportunity"
        ? `「${module.module_name}」的历史候选参考价约 ${referencePrice} 元，低于当前模块预算。`
        : pressure === "healthy"
          ? `「${module.module_name}」有 ${withinBudget.length}/${prices.length} 个历史候选在模块预算内。`
          : `「${module.module_name}」的历史候选对当前模块预算形成压力。`;

    return {
      module_id: module.module_id,
      module_name: module.module_name,
      budget_allocation: module.budget_allocation,
      candidate_count: candidates.length,
      priced_candidate_count: prices.length,
      within_budget_count: withinBudget.length,
      minimum_price: prices[0],
      median_price: medianPrice,
      reference_price: referencePrice,
      budget_gap: referencePrice === undefined ? undefined : roundMoney(module.budget_allocation - referencePrice),
      pressure,
      confidence: prices.length >= 3 ? "high" : prices.length >= 2 ? "medium" : "low",
      summary
    };
  });

  const observed = signals.filter((signal) => signal.pressure !== "unobserved");
  const pressureModules = observed
    .filter((signal) => signal.pressure === "tight" || signal.pressure === "over_budget")
    .map((signal) => signal.module_id);
  const opportunityModules = observed
    .filter((signal) => signal.pressure === "opportunity")
    .map((signal) => signal.module_id);
  const status: MarketFeedback["status"] = observed.length < Math.min(2, modules.length)
    ? "insufficient_data"
    : pressureModules.length > 0
      ? "under_pressure"
      : opportunityModules.length > 0
        ? "opportunity"
        : "balanced";

  return {
    status,
    observed_modules: observed.length,
    total_modules: modules.length,
    observed_planned_budget: roundMoney(observed.reduce((sum, signal) => sum + signal.budget_allocation, 0)),
    observed_reference_total: roundMoney(observed.reduce((sum, signal) => sum + (signal.reference_price ?? 0), 0)),
    observed_budget_gap: roundMoney(observed.reduce((sum, signal) => sum + (signal.budget_gap ?? 0), 0)),
    module_signals: Object.fromEntries(signals.map((signal) => [signal.module_id, signal])),
    pressure_modules: pressureModules,
    opportunity_modules: opportunityModules,
    reallocation_suggestions: [],
    summary: status === "insufficient_data"
      ? `已读取 ${observed.length}/${modules.length} 个模块的冻结候选，继续完成其余模块。`
      : status === "under_pressure"
        ? "部分历史候选超出模块预算；公开 Demo 只展示判断，不自动调整预算。"
        : status === "opportunity"
          ? "历史候选价格整体可控，实际购买前仍需重新核验实时价格、库存与规格。"
          : "历史候选价格与规划基本匹配，暂不需要调整预算。",
    user_confirmation_required: true,
    generated_at: DEMO_CAPTURED_AT
  };
}

function buildHostedTasks(modules: ShoppingPlanModule[]): HostedExecutionTask[] {
  return modules.map((module) => ({
    task_id: `frozen-search-${module.module_id}`,
    task_type: "module_search",
    session_id: DEMO_SESSION_ID,
    status: "completed",
    title: `筛选「${module.module_name}」候选`,
    description: `从 2026-08-08 的脱敏历史快照读取「${module.module_name}」候选。`,
    module_id: module.module_id,
    module_name: module.module_name,
    created_at: DEMO_CAPTURED_AT,
    updated_at: DEMO_CAPTURED_AT,
    payload: {
      keyword: module.search_strategy?.primary_keyword ?? module.search_keyword ?? module.module_name,
      source: "frozen_public_demo",
      network_access: false
    },
    result_summary: "已从本地冻结快照读取 3 件候选；未访问淘宝账号。",
    executor: "local_executor",
    runtime_job_id: `frozen-job-${module.module_id}`
  }));
}

function buildCompletionReport(
  totalBudget: number,
  modules: ShoppingPlanModule[],
  candidatesByModule: Record<string, ProductCandidate[]>,
  workflowRunId = DEMO_WORKFLOW_RUN_ID
): NonNullable<SessionState["completion_report"]> {
  const primaryProducts = modules
    .map((module) => candidatesByModule[module.module_id]?.[0])
    .filter((product): product is ProductCandidate => Boolean(product));
  const estimatedTotal = roundMoney(primaryProducts.reduce((sum, product) => sum + product.price, 0));
  const moduleIds = modules.map((module) => module.module_id);
  const bundleItems = primaryProducts.map((product) => {
    const module = modules.find((item) => item.module_id === product.module_id);
    return {
      module_id: product.module_id,
      module_name: module?.module_name ?? product.module_id,
      product_id: product.product_id,
      title: product.title,
      price: product.price,
      recommendation_type: product.recommendation_type,
      optional: Boolean(module?.optional),
      reason: `${product.fit_reason} 价格落在当前模块预算内。`
    };
  });

  return {
    status: "ready",
    source: "policy",
    workflow_run_id: workflowRunId,
    decision_id: "frozen-decision-complete",
    total_modules: modules.length,
    covered_module_ids: moduleIds,
    uncovered_module_ids: [],
    critical_module_ids: moduleIds,
    critical_covered_module_ids: moduleIds,
    skipped_module_ids: [],
    thin_module_ids: [],
    budget_pressure_module_ids: [],
    unpriced_module_ids: [],
    total_candidates: Object.values(candidatesByModule)
      .reduce((total, candidates) => total + candidates.length, 0),
    coverage_ratio: 1,
    critical_coverage_ratio: 1,
    stop_reason: `${modules.length} 个规划模块均已从冻结快照形成三档候选，继续扩搜的演示价值较低。`,
    summary: "已覆盖全部必需模块并形成可比较候选；公开 Demo 不会继续访问真实平台。",
    strengths: [
      `已覆盖全部 ${modules.length} 个规划模块。`,
      "每个模块均保留稳妥、性价比、升级三档候选。",
      "推荐与演示清单均只使用本地冻结数据。"
    ],
    caveats: ["历史价格、库存、规格与链接状态均未做实时校验。"],
    next_steps: ["对比商品；真实购买前查看淘宝详情确认规格，再显式选择是否加购。"],
    purchase_bundle: {
      status: "ready",
      source: "policy",
      total_budget: totalBudget,
      estimated_total: estimatedTotal,
      remaining_budget: roundMoney(Math.max(0, totalBudget - estimatedTotal)),
      selected_module_ids: moduleIds,
      omitted_module_ids: [],
      critical_module_ids: moduleIds,
      critical_selected_module_ids: moduleIds,
      items: bundleItems,
      summary: `Agent 在 ${totalBudget} 元总预算内优先覆盖 ${modules.length} 个规划模块，并保留 ${roundMoney(Math.max(0, totalBudget - estimatedTotal))} 元余量。`,
      caveats: ["组合基于 2026-08-08 历史快照，实际购买前需复核。"],
      guardrails: [
        "只允许选择冻结候选中的商品 ID",
        "加入购物车前必须由用户确认",
        "公开 Demo 不调用搜索、加购、下单或支付能力"
      ],
      generated_at: DEMO_CAPTURED_AT
    },
    generated_at: DEMO_CAPTURED_AT
  };
}

export function buildFrozenDemoSession(
  rawInput: string = DEMO_DEFAULT_INPUT,
  budget?: number
): SessionState {
  const input = rawInput.trim() || DEMO_DEFAULT_INPUT;
  const totalBudget = normalizedBudget(input, budget);
  const baseTemplate = DEMO_MODULE_IDS.map((moduleId) => ({
    ...MODULE_DEFINITIONS[moduleId].module,
    typical_item_types: [...MODULE_DEFINITIONS[moduleId].module.typical_item_types]
  }));
  const planModules = buildPlanModules(totalBudget);
  const moduleCandidates = buildProducts();
  const moduleReviews = Object.fromEntries(planModules.map((module) => [module.module_id, {
    module_id: module.module_id,
    status: "ready" as const,
    source: "heuristic" as const,
    summary: `「${module.module_name}」已保留 3 件定位不同且可比较的历史候选。`,
    strengths: ["候选覆盖三档推荐", "价格字段完整", "模块意图匹配"],
    caveats: ["未实时打开商品详情页，规格和库存仍需用户复核。"],
    next_action: "进入结果页比较候选；需要购买时再显式确认。",
    generated_at: DEMO_CAPTURED_AT
  }]));
  const moduleSearchTraces = Object.fromEntries(planModules.map((module) => [module.module_id, {
    module_id: module.module_id,
    module_name: module.module_name,
    status: "ready" as const,
    primary_keyword: module.search_strategy?.primary_keyword ?? module.module_name,
    searched_keywords: [module.search_strategy?.primary_keyword ?? module.module_name],
    attempts: [{
      keyword: module.search_strategy?.primary_keyword ?? module.module_name,
      reason: "回放公开 Demo 的本地冻结快照。",
      result_count: 3,
      status: "success" as const,
      created_at: DEMO_CAPTURED_AT
    }],
    result_count: 3,
    candidate_count: 3,
    review_status: "ready" as const,
    review_summary: `已从本地快照读取「${module.module_name}」三档候选。`,
    ai_decision_summary: "候选数量和差异度足够，停止扩搜。",
    next_action: "进入结果比较",
    generated_at: DEMO_CAPTURED_AT,
    updated_at: DEMO_CAPTURED_AT
  }]));
  const marketFeedback = buildMarketFeedback(planModules, moduleCandidates);
  const completionReport = buildCompletionReport(totalBudget, planModules, moduleCandidates);

  return {
    session_id: DEMO_SESSION_ID,
    owner_id: "public-demo",
    raw_input: input,
    scene_brief: {
      scenario_id: "new-car",
      scene_type: "新车选购",
      vehicle_type: input.includes("SUV") ? "SUV" : input.includes("混动") ? "混动车" : "新能源车",
      user_stage: input.includes("首月") ? "首月补齐" : input.includes("第一周") ? "第一周" : "提车初期",
      budget: totalBudget,
      priority_style: input.includes("性价比")
        ? "性价比优先"
        : input.includes("舒适")
          ? "舒适优先"
          : input.includes("安全") && !input.includes("实用")
            ? "安全优先"
            : "实用优先",
      already_have: ["行车记录仪", "车载手机支架", "应急启动电源", "车载充电器", "脚垫", "纸巾收纳"]
        .filter((item) => input.includes(`已有${item}`) || input.includes(`有${item}`)),
      avoid_items: ["装饰类", "香薰摆件", "高价升级款", "复杂安装类", "占空间收纳箱"]
        .filter((item) => input.includes(item.replace("类", "")) || input.includes(item)),
      optional_notes: input
    },
    base_template: baseTemplate,
    shopping_plan: {
      modules: planModules,
      overall_rationale: "以实用与安全为主线，先覆盖提车初期的高频需求，再把低频装饰与升级项后置。",
      personalization_summary: "已按新能源车、儿童长途同行和预算约束，将标准新车模板收敛为四个可执行模块。",
      execution_strategy: {
        module_sequence: [...DEMO_MODULE_IDS],
        budget_guardrails: [
          `总预算控制在 ${totalBudget} 元内，优先满足安全必需与车内实用。`,
          "单件升级款只有在核心模块预算未超支时才保留。"
        ],
        tradeoffs: [
          "装饰类与低频升级项默认后置，避免首购阶段分散预算。",
          "收纳用品先验证尺寸和真实使用频率，避免占用后备箱空间。"
        ],
        search_notes: [
          "每个模块使用独立搜索意图，公开 Demo 只回放已脱敏的历史结果。",
          "推荐优先比较适配性、店铺信息和价格是否落在模块预算内。"
        ],
        stop_rules: [
          "每个模块得到稳妥、性价比、升级三档候选后停止扩搜。",
          "候选触及排除项时跳过，不将预算挪给无关商品。"
        ]
      },
      agent_directives: {
        autonomy_level: "平衡执行",
        search_depth: "轻量搜索",
        detail_policy: "公开 Demo 不打开实时商品详情；真实产品只有用户主动点击时才进入淘宝详情页。",
        recovery_policy: "冻结候选缺失时保留模块缺口，不调用网络补搜。",
        rerank_rules: [
          "优先保留标题和模块意图高度匹配的商品",
          "优先保留价格落在模块预算区间内的商品",
          "同档位中优先选择店铺信息更明确的商品"
        ],
        user_confirmation_points: ["加入购物车前必须由用户确认", "打开外部淘宝详情页前保持用户可控"],
        safety_boundaries: [
          "不读取淘宝账号、订单、地址、手机号或聊天记录",
          "不调用实时搜索、加购、下单或支付能力",
          "确认加购只写入产品内演示清单"
        ]
      }
    },
    plan_review: {
      status: "ready",
      source: "heuristic",
      summary: "四个模块的预算、搜索词与执行边界完整，可以进入冻结快照回放。",
      strengths: ["模块优先级明确", "预算合计与总预算一致", "加购前保留用户确认"],
      risks: ["公开 Demo 使用历史快照，无法代表当前价格、库存与规格。"],
      improvement_suggestions: ["购买前打开实时详情页复核车型适配与具体 SKU。"],
      budget_comment: `当前四个模块预算合计 ${totalBudget} 元，与用户预算一致。`,
      keyword_comment: "四个模块均使用独立搜索意图，避免候选重复。",
      module_comment: "当前只保留安全、实用、清洁与收纳四个首购模块。",
      generated_at: DEMO_CAPTURED_AT
    },
    module_candidates: moduleCandidates,
    module_reviews: moduleReviews,
    module_search_traces: moduleSearchTraces,
    market_feedback: marketFeedback,
    agent_decisions: [{
      decision_id: "frozen-decision-complete",
      action: "complete_workflow",
      source: "policy_fallback",
      confidence: "high",
      reason: "四个模块均已形成三档候选，继续扩搜的边际收益较低。",
      evidence: ["4/4 模块已覆盖", "共 12 件候选", "每个模块均有三档推荐"],
      expected_gain: "停止扩搜并进入用户比较阶段。",
      tool_cost: 4,
      guardrail_notes: ["全部数据来自本地冻结快照", "未访问淘宝账号"],
      decision_latency_ms: 0,
      created_at: DEMO_CAPTURED_AT,
      consumed_at: DEMO_CAPTURED_AT
    }],
    agent_runtime: {
      max_tool_calls: 8,
      used_tool_calls: 4,
      model_decisions: 0,
      policy_decisions: 1,
      model_proposals: 0,
      model_rejections: 0,
      model_failures: 0,
      total_decision_latency_ms: 0,
      last_decision_at: DEMO_CAPTURED_AT,
      last_decision_mode: "policy",
      workflow_status: "completed",
      auto_continue: false,
      workflow_run_id: DEMO_WORKFLOW_RUN_ID,
      continuation_count: 4,
      workflow_message: "冻结快照回放完成，可以查看商品推荐。",
      last_transition_at: DEMO_CAPTURED_AT,
      initialized_at: DEMO_CAPTURED_AT
    },
    llm_calls: [
      {
        id: "frozen-llm-parse-scene",
        task: "parse_scene",
        model: "frozen-demo",
        mode: "fallback",
        duration_ms: 0,
        reason: "公开 Demo 使用固定场景理解结果。",
        created_at: DEMO_CAPTURED_AT
      },
      {
        id: "frozen-llm-personalize-plan",
        task: "personalize_template",
        model: "frozen-demo",
        mode: "fallback",
        duration_ms: 0,
        reason: "公开 Demo 使用固定四模块规划。",
        created_at: DEMO_CAPTURED_AT
      },
      {
        id: "frozen-llm-review-candidates",
        task: "review_candidates",
        model: "frozen-demo",
        mode: "fallback",
        duration_ms: 0,
        reason: "公开 Demo 使用固定候选审查结果。",
        created_at: DEMO_CAPTURED_AT
      }
    ],
    completion_report: completionReport,
    selected_items: [],
    tool_logs: planModules.map((module) => ({
      id: `frozen-tool-${module.module_id}`,
      timestamp: DEMO_CAPTURED_AT,
      tool_name: "read_frozen_snapshot",
      module_id: module.module_id,
      module_name: module.module_name,
      input_summary: module.search_strategy?.primary_keyword ?? module.module_name,
      output_summary: "读取 3 件本地历史候选。",
      status: "success",
      duration_ms: 0,
      mode: "local_executor"
    })),
    hosted_tasks: buildHostedTasks(planModules),
    execution_mode: "local_executor",
    permissions_scope: ["读取本地冻结快照", "加入购物车需显式确认", "不下单或支付"],
    deepseek_status: "mock",
    mcp_status: "unavailable",
    current_scene_label: "新车选购",
    last_action: "公开 Demo 已载入 2026-08-08 冻结快照"
  };
}

function scenarioBudgetAllocations(modules: PlanningModule[], totalBudget: number) {
  const totalWeight = modules.reduce((sum, module) => sum + Math.max(0.01, module.default_budget_ratio), 0);
  const allocations = Object.fromEntries(modules.map((module) => [
    module.module_id,
    Math.floor(totalBudget * Math.max(0.01, module.default_budget_ratio) / totalWeight)
  ])) as Record<string, number>;
  const allocated = modules.reduce((sum, module) => sum + allocations[module.module_id], 0);
  if (modules[0]) allocations[modules[0].module_id] += totalBudget - allocated;
  return allocations;
}

function buildScenarioPlanModules(
  scenarioId: Exclude<ScenarioId, "new-car">,
  totalBudget: number,
  avoidItems: string[]
): ShoppingPlanModule[] {
  const scenario = getScenarioConfig(scenarioId);
  const allocations = scenarioBudgetAllocations(scenario.base_template_modules, totalBudget);
  return scenario.base_template_modules.map((module) => {
    const itemTypes = [...module.typical_item_types];
    const primaryKeyword = itemTypes[0] ?? module.module_name;
    const moduleBudget = allocations[module.module_id];
    return {
      ...module,
      typical_item_types: itemTypes,
      origin: "base_template",
      priority: module.default_priority,
      budget_allocation: moduleBudget,
      rationale: `${module.description} 公开 Demo 会按真实产品规则保留三档本地样本。`,
      recommendation_strategy: "先比较场景匹配与预算，再保留稳妥、性价比、升级三档候选。",
      search_keyword: primaryKeyword,
      search_strategy: {
        primary_keyword: primaryKeyword,
        alternate_keywords: itemTypes.slice(1, 4),
        include_terms: itemTypes.slice(0, 3),
        exclude_terms: avoidItems,
        ranking_focus: ["场景匹配", "预算合理", "规格清晰"],
        must_have_signals: [module.module_name, primaryKeyword],
        reject_signals: ["规格不明", ...avoidItems],
        quality_checks: ["标题匹配模块", "价格字段完整", "购买前复核规格"],
        price_band: `建议控制在 ${Math.max(20, Math.round(moduleBudget * 0.2))}-${Math.max(60, Math.round(moduleBudget * 0.8))} 元区间`,
        reasoning: `围绕“${primaryKeyword}”筛选与${module.module_name}直接相关的公开演示样本。`,
        failure_recovery: "冻结样本不足时保留缺口，不访问网络补搜。"
      },
      status: "ready"
    };
  });
}

function buildScenarioProducts(
  scenarioId: Exclude<ScenarioId, "new-car">,
  modules: ShoppingPlanModule[],
  workflowRunId: string
) {
  const scenario = getScenarioConfig(scenarioId);
  const priceFactors = [0.44, 0.3, 0.68];
  const tierLabels = ["稳妥样本", "性价比样本", "升级样本"];
  return Object.fromEntries(modules.map((module) => [
    module.module_id,
    RECOMMENDATION_TYPES.map((recommendationType, index): ProductCandidate => {
      const itemType = module.typical_item_types[index % Math.max(1, module.typical_item_types.length)]
        ?? module.module_name;
      const price = Math.max(19, Math.round(module.budget_allocation * priceFactors[index]));
      const productId = `public-${scenarioId}-${module.module_id}-${index + 1}`;
      const searchKeyword = `${itemType} ${module.module_name}`;
      const detailUrl = `https://s.taobao.com/search?q=${encodeURIComponent(searchKeyword)}`;
      const fitReason = scenario.product_reason_style[recommendationType];
      return {
        product_id: productId,
        title: `${itemType}｜${scenario.name}${tierLabels[index]}`,
        price,
        source: "SceneCart 公开冻结样本",
        shop_name: "公开演示样本 · 非实时商品",
        image_url: `/demo-products/scenes/${scenarioId}/${module.module_id}.svg`,
        detail_url: detailUrl,
        shop_badges: [],
        highlights: [itemType, module.module_name],
        risk_notes: ["这是用于还原产品流程的本地演示样本，不代表实时商品、价格、库存或规格。"],
        fit_reason: fitReason,
        recommendation_type: recommendationType,
        module_id: module.module_id,
        detail_evidence: {
          schema: "scenecart.taobao-mcp-product-detail-evidence/v1",
          source: "taobao-mcp",
          status: "unavailable",
          tool: "navigate_to_url+read_page_content",
          tools_used: [],
          source_app: "SceneCart Public Demo（本地演示样本）",
          job_id: `frozen-detail-${productId}`,
          search_job_id: `frozen-search-${module.module_id}`,
          module_id: module.module_id,
          workflow_run_id: workflowRunId,
          product_id: productId,
          detail_url: detailUrl,
          captured_at: DEMO_CAPTURED_AT,
          unavailable_reason: "这是品类级冻结样本；可从淘宝搜索入口自行查看当前真实商品。",
          recommendation_reason: fitReason
        }
      };
    })
  ]));
}

export function buildFrozenDemoSessionForScenario(
  scenarioId: ScenarioId,
  rawInput?: string,
  budget?: number
): SessionState {
  if (scenarioId === "new-car") return buildFrozenDemoSession(rawInput, budget);

  const scenario = getScenarioConfig(scenarioId);
  const input = rawInput?.trim() || scenario.example_prompts[0] || scenario.input_placeholder;
  const totalBudget = normalizedBudget(input, budget);
  const vehicleOptions = scenario.field_option_sets.vehicle_type ?? [];
  const stageOptions = scenario.field_option_sets.user_stage ?? [];
  const priorityOptions = scenario.field_option_sets.priority_style ?? [];
  const alreadyHaveOptions = scenario.field_option_sets.already_have ?? [];
  const avoidOptions = scenario.field_option_sets.avoid_items ?? [];
  const alreadyHave = alreadyHaveOptions.filter((item) => input.includes(item));
  const avoidItems = avoidOptions.filter((item) => input.includes(item.replace(/^不/, "")) || input.includes(item));
  const planModules = buildScenarioPlanModules(scenarioId, totalBudget, avoidItems);
  const workflowRunId = `public-demo-${scenarioId}-workflow-2026-08-08`;
  const sessionId = `public-demo-${scenarioId}-2026-08-08`;
  const moduleCandidates = buildScenarioProducts(scenarioId, planModules, workflowRunId);
  const moduleReviews = Object.fromEntries(planModules.map((module) => [module.module_id, {
    module_id: module.module_id,
    status: "ready" as const,
    source: "heuristic" as const,
    summary: `「${module.module_name}」已保留 3 件定位不同的本地演示样本。`,
    strengths: ["候选覆盖三档推荐", "价格字段完整", "模块意图匹配"],
    caveats: ["本地演示样本不是实时淘宝商品，购买前需重新搜索并复核。"],
    next_action: "进入结果页比较候选；点击加购后会直接写入产品内演示清单。",
    generated_at: DEMO_CAPTURED_AT
  }]));
  const moduleSearchTraces = Object.fromEntries(planModules.map((module) => [module.module_id, {
    module_id: module.module_id,
    module_name: module.module_name,
    status: "ready" as const,
    primary_keyword: module.search_strategy?.primary_keyword ?? module.module_name,
    searched_keywords: [module.search_strategy?.primary_keyword ?? module.module_name],
    attempts: [{
      keyword: module.search_strategy?.primary_keyword ?? module.module_name,
      reason: "回放公开 Demo 的本地冻结样本。",
      result_count: 3,
      status: "success" as const,
      created_at: DEMO_CAPTURED_AT
    }],
    result_count: 3,
    candidate_count: 3,
    review_status: "ready" as const,
    review_summary: `已读取「${module.module_name}」三档本地样本。`,
    ai_decision_summary: "样本数量和差异度足够，停止扩搜。",
    next_action: "进入结果比较",
    generated_at: DEMO_CAPTURED_AT,
    updated_at: DEMO_CAPTURED_AT
  }]));
  const base = buildFrozenDemoSession(input, totalBudget);
  const moduleIds = planModules.map((module) => module.module_id);
  const marketFeedback = buildMarketFeedback(planModules, moduleCandidates);

  base.session_id = sessionId;
  base.raw_input = input;
  base.scene_brief = {
    scenario_id: scenarioId,
    scene_type: scenario.name,
    vehicle_type: vehicleOptions.find((item) => input.includes(item)) ?? vehicleOptions[0] ?? scenario.name,
    user_stage: stageOptions.find((item) => input.includes(item)) ?? stageOptions[0] ?? "起步阶段",
    budget: totalBudget,
    priority_style: priorityOptions.find((item) => input.includes(item.replace("优先", ""))) ?? priorityOptions[0] ?? "实用优先",
    already_have: alreadyHave,
    avoid_items: avoidItems,
    optional_notes: input
  };
  base.base_template = scenario.base_template_modules.map((module) => ({
    ...module,
    typical_item_types: [...module.typical_item_types]
  }));
  base.shopping_plan = {
    modules: planModules,
    overall_rationale: scenario.planning_summary_template,
    personalization_summary: `已按${scenario.name}的场景、预算与排除项，将标准模板整理为 ${planModules.length} 个可执行模块。`,
    execution_strategy: {
      module_sequence: moduleIds,
      budget_guardrails: [`总预算控制在 ${totalBudget} 元内，优先满足高频且非可选模块。`],
      tradeoffs: ["已有物品与排除项优先于升级类需求，减少重复购买。"],
      search_notes: ["公开 Demo 只回放本地冻结样本，不访问淘宝账号或实时商品页。"],
      stop_rules: ["每个模块形成三档可比较样本后停止扩搜。"]
    },
    agent_directives: {
      ...base.shopping_plan.agent_directives,
      detail_policy: "公开 Demo 不打开外部商品详情；正式产品保持用户主动进入详情页。",
      recovery_policy: "冻结样本缺失时保留模块缺口，不调用网络补搜。"
    }
  };
  base.plan_review = {
    status: "ready",
    source: "heuristic",
    summary: `${planModules.length} 个模块的预算、搜索词与执行边界完整，可以进入冻结样本回放。`,
    strengths: ["模块优先级明确", "预算合计与总预算一致", "加购前保留用户确认"],
    risks: ["除新车主场景外使用公开演示样本，不代表实时平台商品。"],
    improvement_suggestions: ["真实购买时重新搜索并复核价格、库存与规格。"],
    budget_comment: `当前模块预算合计 ${totalBudget} 元，与用户预算一致。`,
    keyword_comment: "每个模块使用独立搜索意图，避免候选重复。",
    module_comment: `当前保留 ${planModules.length} 个${scenario.name}规划模块。`,
    generated_at: DEMO_CAPTURED_AT
  };
  base.module_candidates = moduleCandidates;
  base.module_reviews = moduleReviews;
  base.module_search_traces = moduleSearchTraces;
  base.market_feedback = marketFeedback;
  base.agent_decisions = [{
    decision_id: `frozen-${scenarioId}-decision-complete`,
    action: "complete_workflow",
    source: "policy_fallback",
    confidence: "high",
    reason: `${planModules.length} 个模块均已形成三档本地样本，继续扩搜的演示价值较低。`,
    evidence: [`${planModules.length}/${planModules.length} 模块已覆盖`, `共 ${planModules.length * 3} 件样本`],
    expected_gain: "停止扩搜并进入用户比较阶段。",
    tool_cost: planModules.length,
    guardrail_notes: ["全部数据来自浏览器内冻结样本", "未访问淘宝账号"],
    decision_latency_ms: 0,
    created_at: DEMO_CAPTURED_AT,
    consumed_at: DEMO_CAPTURED_AT
  }];
  base.agent_runtime = {
    ...base.agent_runtime,
    max_tool_calls: Math.max(8, planModules.length * 2),
    used_tool_calls: planModules.length,
    workflow_run_id: workflowRunId,
    continuation_count: planModules.length
  };
  base.llm_calls = base.llm_calls.map((call) => ({
    ...call,
    reason: `公开 Demo 使用${scenario.name}的固定本地演示样本。`
  }));
  base.completion_report = buildCompletionReport(totalBudget, planModules, moduleCandidates, workflowRunId);
  base.selected_items = [];
  base.tool_logs = planModules.map((module) => ({
    id: `frozen-tool-${module.module_id}`,
    timestamp: DEMO_CAPTURED_AT,
    tool_name: "read_frozen_snapshot",
    module_id: module.module_id,
    module_name: module.module_name,
    input_summary: module.search_strategy?.primary_keyword ?? module.module_name,
    output_summary: "读取 3 件本地演示样本。",
    status: "success",
    duration_ms: 0,
    mode: "local_executor"
  }));
  base.hosted_tasks = buildHostedTasks(planModules).map((task) => ({
    ...task,
    session_id: sessionId,
    description: `从浏览器内冻结样本读取「${task.module_name}」候选。`
  }));
  base.current_scene_label = scenario.name;
  base.last_action = `公开 Demo 已载入${scenario.name}本地冻结样本`;
  return base;
}

export function withFrozenSearchProgress(
  fullSession: SessionState,
  completedCount: number
): SessionState {
  const moduleIds = fullSession.shopping_plan.modules.map((module) => module.module_id);
  const completed = Math.max(0, Math.min(
    moduleIds.length,
    Number.isFinite(completedCount) ? Math.floor(completedCount) : 0
  ));
  const visibleModuleIds = new Set<string>(moduleIds.slice(0, completed));
  const next = structuredClone(fullSession);

  next.module_candidates = Object.fromEntries(
    Object.entries(next.module_candidates).filter(([moduleId]) => visibleModuleIds.has(moduleId))
  );
  next.module_reviews = Object.fromEntries(
    Object.entries(next.module_reviews).filter(([moduleId]) => visibleModuleIds.has(moduleId))
  );
  next.module_search_traces = Object.fromEntries(
    Object.entries(next.module_search_traces).filter(([moduleId]) => visibleModuleIds.has(moduleId))
  );
  next.tool_logs = next.tool_logs.filter((log) => !log.module_id || visibleModuleIds.has(log.module_id));
  next.hosted_tasks = next.hosted_tasks.map((task, index) => {
    const status: HostedExecutionTask["status"] = index < completed
      ? "completed"
      : index === completed && completed < moduleIds.length
        ? "running"
        : "pending";
    return {
      ...task,
      status,
      result_summary: status === "completed"
        ? "已从本地冻结快照读取 3 件候选；未访问淘宝账号。"
        : undefined
    };
  });
  next.market_feedback = buildMarketFeedback(next.shopping_plan.modules, next.module_candidates);

  const completedAll = completed === moduleIds.length;
  next.agent_decisions = completedAll ? next.agent_decisions : [];
  next.agent_runtime = {
    ...next.agent_runtime,
    used_tool_calls: completed,
    policy_decisions: completedAll ? 1 : 0,
    last_decision_mode: completedAll ? "policy" : "none",
    last_decision_at: completedAll ? DEMO_CAPTURED_AT : undefined,
    workflow_status: completedAll ? "completed" : "running",
    current_module_id: completedAll ? undefined : moduleIds[completed],
    continuation_count: completed,
    workflow_message: completedAll
      ? "冻结快照回放完成，可以查看商品推荐。"
      : `正在回放第 ${completed + 1}/${moduleIds.length} 个模块的冻结候选。`,
    last_transition_at: DEMO_CAPTURED_AT
  };

  if (!completedAll) {
    delete next.completion_report;
    delete next.bundle_adoption;
  }
  next.last_action = completedAll
    ? "公开 Demo 冻结搜索已完成"
    : `公开 Demo 冻结搜索进度 ${completed}/${moduleIds.length}`;
  return next;
}

export function findFrozenDemoProduct(
  session: Pick<SessionState, "module_candidates">,
  productId: string
): ProductCandidate | undefined {
  for (const candidates of Object.values(session.module_candidates)) {
    const product = candidates.find((candidate) => candidate.product_id === productId);
    if (product) return product;
  }
  return undefined;
}
