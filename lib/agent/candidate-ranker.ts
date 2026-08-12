import { SearchResultItem } from "@/lib/mcp/types";
import { ProductCandidate, SceneBrief, ShoppingPlanModule } from "@/lib/session/types";

type RankedSearchResult = {
  item: SearchResultItem;
  recommendation_type: ProductCandidate["recommendation_type"];
  score: number;
  reasons: string[];
};

export interface CandidateRankingContext {
  rerank_rules?: string[];
  budget_guardrails?: string[];
}

export interface CandidatePoolMergeResult {
  candidates: ProductCandidate[];
  previous_count: number;
  incoming_count: number;
  unique_count: number;
  added_product_ids: string[];
  retained_product_ids: string[];
  dropped_product_ids: string[];
}

const QUALITY_TERMS = ["旗舰店", "官方", "正品", "高清", "夜视", "原厂", "稳定", "耐用", "无线", "真空", "磁吸"];
const PRACTICAL_TERMS = ["专用", "固定", "收纳", "清洁", "充电", "便携", "防滑", "免安装", "通用"];
const COMFORT_TERMS = ["舒适", "柔软", "静音", "透气", "护颈", "腰靠", "遮阳", "升级"];
const SAFETY_TERMS = ["安全", "应急", "记录仪", "胎压", "夜视", "防爆", "停车监控", "预警"];
const AGENT_RULE_STOPWORDS = new Set([
  "优先",
  "保留",
  "选择",
  "商品",
  "模块",
  "当前",
  "预算",
  "价格",
  "用户",
  "场景",
  "推荐",
  "候选",
  "规则",
  "以内",
  "更高",
  "更低"
]);

function includesAny(text: string, terms: string[]) {
  return terms.some((term) => term && text.includes(term));
}

function tokenizeIntent(module: ShoppingPlanModule) {
  const words = [
    module.module_name,
    module.search_keyword ?? "",
    module.search_strategy?.primary_keyword ?? "",
    module.recommendation_strategy,
    ...module.typical_item_types,
    ...(module.search_strategy?.alternate_keywords ?? []),
    ...(module.search_strategy?.include_terms ?? []),
    ...(module.search_strategy?.must_have_signals ?? [])
  ];

  return words
    .join(" ")
    .split(/[\s·,，、/｜|]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function scoreTextMatch(text: string, tokens: string[]) {
  return tokens.reduce((score, token) => score + (text.includes(token) ? 7 : 0), 0);
}

function scoreBudgetFit(price: number, budget: number, priorityStyle: SceneBrief["priority_style"]) {
  if (!price || !budget) {
    return 0;
  }

  const ratio = price / budget;
  if (ratio <= 0.12) {
    return priorityStyle === "性价比优先" ? 16 : 8;
  }
  if (ratio <= 0.34) {
    return priorityStyle === "性价比优先" ? 20 : 14;
  }
  if (ratio <= 0.72) {
    return 10;
  }
  if (ratio <= 1) {
    return priorityStyle === "舒适优先" ? 8 : 3;
  }
  return priorityStyle === "性价比优先" ? -18 : -10;
}

function scorePreference(text: string, scene: SceneBrief) {
  if (scene.priority_style === "安全优先") {
    return includesAny(text, SAFETY_TERMS) ? 14 : 0;
  }
  if (scene.priority_style === "舒适优先") {
    return includesAny(text, COMFORT_TERMS) ? 14 : 0;
  }
  if (scene.priority_style === "性价比优先") {
    return includesAny(text, ["高性价比", "新款", "热卖", "旗舰店"]) ? 8 : 0;
  }
  return includesAny(text, PRACTICAL_TERMS) ? 12 : 0;
}

function scoreAvoidance(text: string, scene: SceneBrief) {
  const avoidPenalty = scene.avoid_items.some((item) => item && text.includes(item)) ? -60 : 0;
  const alreadyHavePenalty = scene.already_have.some((item) => item && text.includes(item)) ? -24 : 0;
  return avoidPenalty + alreadyHavePenalty;
}

function scoreSearchStrategy(text: string, module: ShoppingPlanModule) {
  const strategy = module.search_strategy;
  if (!strategy) {
    return { score: 0, reasons: [] as string[] };
  }

  let score = 0;
  const reasons: string[] = [];
  const includeMatches = strategy.include_terms.filter((term) => term && text.includes(term));
  const excludeMatches = strategy.exclude_terms.filter((term) => term && text.includes(term));
  const focusMatches = strategy.ranking_focus.filter((focus) => focus && text.includes(focus));
  const mustHaveMatches = strategy.must_have_signals.filter((term) => term && text.includes(term));
  const rejectMatches = strategy.reject_signals.filter((term) => term && text.includes(term));
  const qualityMatches = strategy.quality_checks.filter((term) => term && text.includes(term));

  if (includeMatches.length > 0) {
    score += includeMatches.length * 9;
    reasons.push("命中AI检索重点");
  }

  if (focusMatches.length > 0) {
    score += Math.min(12, focusMatches.length * 6);
    reasons.push("符合AI排序关注点");
  }

  if (mustHaveMatches.length > 0) {
    score += Math.min(24, mustHaveMatches.length * 8);
    reasons.push("满足AI验收信号");
  }

  if (qualityMatches.length > 0) {
    score += Math.min(12, qualityMatches.length * 4);
    reasons.push("命中AI质量检查项");
  }

  if (excludeMatches.length > 0) {
    score -= 42;
    reasons.push("触及AI排除条件，已降权");
  }

  if (rejectMatches.length > 0) {
    score -= 55;
    reasons.push("触及AI拒绝信号，已降权");
  }

  return { score, reasons };
}

function tokenizeAgentRules(rules: string[]) {
  return Array.from(
    new Set(
      rules
        .flatMap((rule) => rule.match(/[A-Za-z0-9\u4e00-\u9fa5]{2,}/g) ?? [])
        .map((token) => token.trim())
        .filter((token) => token.length >= 2 && !AGENT_RULE_STOPWORDS.has(token))
    )
  ).slice(0, 12);
}

function scoreAgentRules(text: string, context?: CandidateRankingContext) {
  const ruleTokens = tokenizeAgentRules([
    ...(context?.rerank_rules ?? []),
    ...(context?.budget_guardrails ?? [])
  ]);
  const matched = ruleTokens.filter((token) => text.includes(token));

  if (matched.length === 0) {
    return { score: 0, reasons: [] as string[] };
  }

  return {
    score: Math.min(18, matched.length * 6),
    reasons: ["符合AI重排规则"]
  };
}

function scoreShop(item: SearchResultItem) {
  const shopText = `${item.shop_name} ${item.shop_badges.join(" ")}`;
  let score = 0;
  if (shopText.includes("旗舰店")) score += 12;
  if (shopText.includes("官方")) score += 10;
  if (shopText.includes("天猫") || shopText.includes("精选")) score += 6;
  return score;
}

function buildScore(
  scene: SceneBrief,
  module: ShoppingPlanModule,
  item: SearchResultItem,
  context?: CandidateRankingContext
) {
  const text = `${item.title} ${item.shop_name} ${item.shop_badges.join(" ")} ${item.highlights.join(" ")}`;
  const tokens = tokenizeIntent(module);
  const reasons: string[] = [];

  let score = 0;
  const textScore = scoreTextMatch(text, tokens);
  score += textScore;
  if (textScore > 0) reasons.push("匹配模块搜索意图");

  const budgetScore = scoreBudgetFit(item.price, module.budget_allocation, scene.priority_style);
  score += budgetScore;
  if (budgetScore > 8) reasons.push("价格更贴近模块预算");

  const preferenceScore = scorePreference(text, scene);
  score += preferenceScore;
  if (preferenceScore > 0) reasons.push(`符合${scene.priority_style}`);

  const strategyScore = scoreSearchStrategy(text, module);
  score += strategyScore.score;
  reasons.push(...strategyScore.reasons);

  const agentRuleScore = scoreAgentRules(text, context);
  score += agentRuleScore.score;
  reasons.push(...agentRuleScore.reasons);

  const shopScore = scoreShop(item);
  score += shopScore;
  if (shopScore > 0) reasons.push("店铺可信度较高");

  const avoidanceScore = scoreAvoidance(text, scene);
  score += avoidanceScore;
  if (avoidanceScore < 0) reasons.push("存在已有或排除项相关词，已降权");

  if (includesAny(text, QUALITY_TERMS)) {
    score += 6;
    reasons.push("商品标题含质量/适配信号");
  }

  return { score, reasons: reasons.slice(0, 3) };
}

function uniqueByProductId(items: SearchResultItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.product_id || seen.has(item.product_id)) {
      return false;
    }
    seen.add(item.product_id);
    return true;
  });
}

function pickDistinct(
  ranked: Array<{ item: SearchResultItem; score: number; reasons: string[] }>,
  usedIds: Set<string>,
  selector: (item: SearchResultItem) => number
) {
  const sorted = [...ranked]
    .filter((entry) => !usedIds.has(entry.item.product_id))
    .sort((a, b) => selector(b.item) - selector(a.item) || b.score - a.score);
  const picked = sorted[0];
  if (picked) {
    usedIds.add(picked.item.product_id);
  }
  return picked;
}

export function rankCandidatesForModule(
  scene: SceneBrief,
  module: ShoppingPlanModule,
  results: SearchResultItem[],
  context?: CandidateRankingContext
): RankedSearchResult[] {
  const ranked = uniqueByProductId(results)
    .map((item) => ({
      item,
      ...buildScore(scene, module, item, context)
    }))
    .sort((a, b) => b.score - a.score);

  const usedIds = new Set<string>();
  const stable = pickDistinct(ranked, usedIds, () => 0);
  const value = pickDistinct(ranked, usedIds, (item) => {
    if (!item.price || item.price <= 0) {
      return -1;
    }
    return 1 / item.price;
  });
  const upgrade = pickDistinct(ranked, usedIds, (item) => {
    const qualityBoost = includesAny(`${item.title} ${item.shop_name}`, QUALITY_TERMS) ? 100 : 0;
    return qualityBoost + (item.price > 0 ? item.price : -50);
  });

  return [
    stable ? { ...stable, recommendation_type: "稳妥推荐" as const } : null,
    value ? { ...value, recommendation_type: "性价比推荐" as const } : null,
    upgrade ? { ...upgrade, recommendation_type: "升级推荐" as const } : null
  ].filter((item): item is RankedSearchResult => Boolean(item));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function preferText(incoming: string, existing: string) {
  return incoming.trim() || existing.trim();
}

function mergeCandidateRecord(existing: ProductCandidate, incoming: ProductCandidate): ProductCandidate {
  return {
    ...existing,
    ...incoming,
    title: preferText(incoming.title, existing.title),
    price: incoming.price > 0 ? incoming.price : existing.price,
    source: preferText(incoming.source, existing.source),
    shop_name: preferText(incoming.shop_name, existing.shop_name),
    image_url: preferText(incoming.image_url, existing.image_url),
    detail_url: preferText(incoming.detail_url, existing.detail_url),
    shop_badges: uniqueStrings([...existing.shop_badges, ...incoming.shop_badges]),
    highlights: uniqueStrings([...existing.highlights, ...incoming.highlights]),
    risk_notes: uniqueStrings([...existing.risk_notes, ...incoming.risk_notes]),
    fit_reason: preferText(incoming.fit_reason, existing.fit_reason)
  };
}

function asSearchResult(candidate: ProductCandidate): SearchResultItem {
  return {
    product_id: candidate.product_id,
    title: candidate.title,
    price: candidate.price,
    shop_name: candidate.shop_name,
    image_url: candidate.image_url,
    detail_url: candidate.detail_url,
    shop_badges: candidate.shop_badges,
    highlights: candidate.highlights
  };
}

/**
 * A supplemental search must improve the evidence pool instead of replacing it.
 * The returned pool is deliberately capped to the three product roles exposed by
 * the UI, while ranking considers every unique product seen across search rounds.
 */
export function mergeAndRankModuleCandidates(
  scene: SceneBrief,
  module: ShoppingPlanModule,
  previous: ProductCandidate[],
  incoming: ProductCandidate[],
  context?: CandidateRankingContext
): CandidatePoolMergeResult {
  const byId = new Map<string, ProductCandidate>();
  for (const candidate of previous) {
    if (!candidate.product_id) continue;
    byId.set(candidate.product_id, { ...candidate, module_id: module.module_id });
  }
  for (const candidate of incoming) {
    if (!candidate.product_id) continue;
    const normalized = { ...candidate, module_id: module.module_id };
    const existing = byId.get(candidate.product_id);
    byId.set(candidate.product_id, existing ? mergeCandidateRecord(existing, normalized) : normalized);
  }

  const combined = [...byId.values()];
  const ranked = rankCandidatesForModule(
    scene,
    module,
    combined.map(asSearchResult),
    context
  );
  const candidates = ranked.map((entry) => {
    const richCandidate = byId.get(entry.item.product_id)!;
    return {
      ...richCandidate,
      module_id: module.module_id,
      recommendation_type: entry.recommendation_type,
      highlights: uniqueStrings([...richCandidate.highlights, ...entry.reasons]).slice(0, 6)
    };
  });
  const previousIds = new Set(previous.map((candidate) => candidate.product_id).filter(Boolean));
  const incomingIds = new Set(incoming.map((candidate) => candidate.product_id).filter(Boolean));
  const retainedIds = new Set(candidates.map((candidate) => candidate.product_id));

  return {
    candidates,
    previous_count: previous.length,
    incoming_count: incoming.length,
    unique_count: combined.length,
    added_product_ids: [...incomingIds].filter((productId) => !previousIds.has(productId)),
    retained_product_ids: [...retainedIds].filter((productId) => previousIds.has(productId)),
    dropped_product_ids: [...byId.keys()].filter((productId) => !retainedIds.has(productId))
  };
}
