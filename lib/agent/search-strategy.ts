import { searchIntentForModule } from "@/lib/agent/search-intents";
import { SceneBrief, ShoppingPlanModule } from "@/lib/session/types";
import { getScenarioConfig } from "@/lib/scenarios";

function compactKeyword(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function moduleSearchAnchorTerms(module: ShoppingPlanModule) {
  return [
    module.module_name,
    ...module.typical_item_types,
    ...(module.search_strategy?.include_terms ?? []),
    ...(module.search_strategy?.must_have_signals ?? [])
  ]
    .map((term) => compactKeyword(term))
    .filter((term) => term.length >= 2)
    .filter((term, index, list) => list.indexOf(term) === index);
}

export interface AutonomousSearchKeywordValidation {
  valid: boolean;
  normalized: string;
  matched_anchors: string[];
  notes: string[];
}

export interface ModelSearchKeywordNormalization extends AutonomousSearchKeywordValidation {
  repaired: boolean;
  repair_notes: string[];
}

export class InvalidSearchKeywordError extends Error {
  constructor(
    message: string,
    public readonly notes: string[]
  ) {
    super(message);
    this.name = "InvalidSearchKeywordError";
  }
}

const unsafeKeywordPatterns = [
  { pattern: /https?:\/\/|www\./i, note: "自主搜索词不能包含 URL" },
  { pattern: /\b(?:qodercli|taobao-native|sourceApp)\b/i, note: "自主搜索词不能包含工具调用指令" },
  { pattern: /(?:^|\s)--[a-z][\w-]*/i, note: "自主搜索词不能包含命令行参数" },
  { pattern: /(?:忽略|覆盖).{0,8}(?:指令|规则|要求)/i, note: "自主搜索词不能包含提示词控制指令" },
  { pattern: /(?:执行|运行).{0,6}(?:命令|脚本|工具)|(?:system|assistant|tool)\s*[:=]/i, note: "自主搜索词不能包含执行指令" },
  { pattern: /`|\$\(|&&|\|\||[{}]/, note: "自主搜索词包含不安全的控制字符" }
];

const commonCommerceModifiers = [
  "官方",
  "官方旗舰",
  "官方旗舰店",
  "旗舰",
  "旗舰店",
  "品牌",
  "品牌旗舰",
  "品牌旗舰店",
  "高性价比",
  "性价比",
  "入门",
  "升级",
  "新款",
  "基础",
  "实用",
  "耐用",
  "便携",
  "轻量",
  "通用",
  "专用",
  "免安装",
  "免打孔",
  "包安装"
];

function keywordTokens(value: string) {
  return compactKeyword(value)
    .split(/[\s、,，/]+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function moduleStrategyText(module: ShoppingPlanModule) {
  return [
    module.description,
    module.rationale,
    module.recommendation_strategy,
    module.search_keyword,
    module.search_strategy?.primary_keyword,
    ...(module.search_strategy?.alternate_keywords ?? []),
    ...(module.search_strategy?.include_terms ?? []),
    ...(module.search_strategy?.ranking_focus ?? []),
    ...(module.search_strategy?.must_have_signals ?? []),
    ...(module.search_strategy?.quality_checks ?? [])
  ]
    .filter(Boolean)
    .join(" ");
}

function isCommonCommerceModifier(term: string) {
  return commonCommerceModifiers.includes(term);
}

function isPriceModifier(term: string) {
  return /^(?:\d{1,5}(?:-\d{1,5})?|\d{1,5}元(?:以内|以下|左右)?)$/.test(term);
}

export function validateAutonomousSearchKeyword(
  module: ShoppingPlanModule,
  value: string
): AutonomousSearchKeywordValidation {
  const normalized = compactKeyword(value);
  const notes: string[] = [];

  if (!normalized) {
    notes.push("自主搜索词不能为空");
  }
  if (value.length > 80 || normalized.length > 80) {
    notes.push("自主搜索词不能超过 80 个字符");
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    notes.push("自主搜索词不能包含换行或控制字符");
  }

  for (const unsafe of unsafeKeywordPatterns) {
    if (unsafe.pattern.test(value)) {
      notes.push(unsafe.note);
    }
  }

  const anchors = moduleSearchAnchorTerms(module);
  const matchedAnchors = anchors.filter((anchor) => normalized.includes(anchor));
  if (normalized && matchedAnchors.length === 0) {
    notes.push(`自主搜索词必须保留「${module.module_name}」的至少一个品类锚点`);
  }

  return {
    valid: notes.length === 0,
    normalized,
    matched_anchors: matchedAnchors,
    notes: [...new Set(notes)]
  };
}

// Model proposals may omit the category while still providing useful feature or
// price filters. Repair only when every term is already grounded in the module
// strategy (plus a small commerce modifier allowlist); manual/tool inputs remain strict.
export function normalizeModelSearchKeyword(
  module: ShoppingPlanModule,
  value: string
): ModelSearchKeywordNormalization {
  const validation = validateAutonomousSearchKeyword(module, value);
  if (validation.valid) {
    return { ...validation, repaired: false, repair_notes: [] };
  }

  const missingAnchorNote = `自主搜索词必须保留「${module.module_name}」的至少一个品类锚点`;
  if (validation.notes.length !== 1 || validation.notes[0] !== missingAnchorNote) {
    return { ...validation, repaired: false, repair_notes: [] };
  }

  const strategyText = moduleStrategyText(module);
  const terms = keywordTokens(validation.normalized);
  const groundedTerms = terms.filter((term) => strategyText.includes(term));
  const allTermsGrounded = terms.length > 0 && terms.every(
    (term) => strategyText.includes(term) || isCommonCommerceModifier(term) || isPriceModifier(term)
  );
  if (!allTermsGrounded || groundedTerms.length === 0) {
    return { ...validation, repaired: false, repair_notes: [] };
  }

  const anchor = module.typical_item_types.find((term) => compactKeyword(term).length >= 2) ?? module.module_name;
  const repairedValidation = validateAutonomousSearchKeyword(
    module,
    compactKeyword(`${anchor} ${validation.normalized}`)
  );
  if (!repairedValidation.valid) {
    return { ...validation, repaired: false, repair_notes: [] };
  }

  return {
    ...repairedValidation,
    repaired: true,
    repair_notes: [`模型筛选意图已由后端补齐品类锚点「${anchor}」`]
  };
}

export function requireValidModuleSearchKeyword(module: ShoppingPlanModule, value: string) {
  const validation = validateAutonomousSearchKeyword(module, value);
  if (!validation.valid) {
    throw new InvalidSearchKeywordError(validation.notes.join("；"), validation.notes);
  }
  return validation.normalized;
}

function moduleCategoryTerms(module: ShoppingPlanModule) {
  return module.typical_item_types
    .map((term) => compactKeyword(term))
    .filter((term) => term.length >= 2)
    .filter((term, index, list) => list.indexOf(term) === index);
}

// Taobao Desktop is substantially more stable when each request targets one
// concrete product category. The model still controls module selection,
// ranking and filters; this boundary only narrows the tool-facing query.
export function toStableTaobaoSearchKeyword(module: ShoppingPlanModule, value: string) {
  const normalized = compactKeyword(value);
  const categories = moduleCategoryTerms(module);
  const matchedCategory = categories
    .filter((term) => normalized.includes(term))
    .sort((left, right) => right.length - left.length)[0];

  return matchedCategory ?? categories[0] ?? compactKeyword(module.module_name);
}

function keywordSignature(scene: SceneBrief, module: ShoppingPlanModule, keyword: string) {
  const scenario = getScenarioConfig(scene.scenario_id);
  const anchors = moduleSearchAnchorTerms(module).filter((term) => keyword.includes(term));
  if (anchors.length > 0) {
    return anchors.slice(0, 3).join("|");
  }

  const genericTerms = [
    scenario.name,
    scene.vehicle_type,
    scene.user_stage,
    scene.priority_style,
    scene.priority_style.replace("优先", ""),
    "场景化",
    "购物",
    "用品",
    "新车",
    "汽车",
    "车载",
    "车用",
    "推荐",
    "实用"
  ].filter(Boolean);

  return genericTerms
    .sort((a, b) => b.length - a.length)
    .reduce((text, term) => text.replaceAll(term, " "), keyword)
    .replace(/\s+/g, " ")
    .trim();
}

function repairKeywordForDistinctness(
  scene: SceneBrief,
  module: ShoppingPlanModule,
  keyword: string,
  seenSignatures: Set<string>
) {
  const preferred = toStableTaobaoSearchKeyword(module, keyword);
  const candidates = [preferred, ...moduleCategoryTerms(module), compactKeyword(module.module_name)]
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index);
  let repaired = preferred;
  let signature = keywordSignature(scene, module, repaired) || repaired;

  for (const candidate of candidates) {
    const candidateSignature = keywordSignature(scene, module, candidate) || candidate;
    if (!seenSignatures.has(candidateSignature)) {
      repaired = candidate;
      signature = candidateSignature;
      break;
    }
  }

  seenSignatures.add(signature);
  return repaired;
}

function normalizeAlternateKeywords(
  module: ShoppingPlanModule,
  primaryKeyword: string
) {
  const rawAlternates = [
    ...(module.search_strategy?.alternate_keywords ?? []),
    ...moduleCategoryTerms(module)
  ];

  return rawAlternates
    .map((item) => toStableTaobaoSearchKeyword(module, item))
    .filter((item) => item && item !== primaryKeyword)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, 3);
}

export function normalizeSearchKeywords(scene: SceneBrief, modules: ShoppingPlanModule[]) {
  const seenSignatures = new Set<string>();

  return modules.map((module) => {
    const fallbackIntent = searchIntentForModule(scene, module);
    const rawKeyword = (
      module.search_strategy?.primary_keyword?.trim() ||
      module.search_keyword?.trim() ||
      fallbackIntent
    ).replace(/\s+/g, " ");
    const keyword = repairKeywordForDistinctness(scene, module, rawKeyword, seenSignatures);
    const includeTerms =
      module.search_strategy?.include_terms?.length
        ? module.search_strategy.include_terms
        : module.typical_item_types.slice(0, 3);
    const excludeTerms =
      module.search_strategy?.exclude_terms?.length
        ? module.search_strategy.exclude_terms
        : [...scene.avoid_items, ...scene.already_have].slice(0, 5);
    const rankingFocus =
      module.search_strategy?.ranking_focus?.length
        ? module.search_strategy.ranking_focus
        : ["匹配模块意图", "价格贴近预算", "店铺可信度"];
    const mustHaveSignals =
      module.search_strategy?.must_have_signals?.length
        ? module.search_strategy.must_have_signals
        : [module.module_name, ...includeTerms].filter(Boolean).slice(0, 4);
    const rejectSignals =
      module.search_strategy?.reject_signals?.length
        ? module.search_strategy.reject_signals
        : excludeTerms.slice(0, 4);
    const qualityChecks =
      module.search_strategy?.quality_checks?.length
        ? module.search_strategy.quality_checks
        : ["商品图片完整", "详情链接可打开", "店铺信息明确", "规格描述清楚"];
    const alternateKeywords = normalizeAlternateKeywords(module, keyword);
    const distinctivenessNote =
      keyword !== compactKeyword(rawKeyword)
        ? "已将工具搜索词收敛为单一商品类目，以提高淘宝桌面搜索稳定性。"
        : "";

    return {
      ...module,
      search_keyword: keyword,
      search_strategy: {
        primary_keyword: keyword,
        alternate_keywords: alternateKeywords,
        include_terms: includeTerms,
        exclude_terms: excludeTerms,
        ranking_focus: rankingFocus,
        must_have_signals: mustHaveSignals,
        reject_signals: rejectSignals,
        quality_checks: qualityChecks,
        price_band:
          module.search_strategy?.price_band ||
          `建议控制在模块预算 ${Math.round(module.budget_allocation * 0.35)}-${Math.round(module.budget_allocation * 1.1)} 元附近`,
        reasoning:
          [module.search_strategy?.reasoning || `用“${keyword}”作为首轮搜索词，再按${rankingFocus.join("、")}筛选。`, distinctivenessNote]
            .filter(Boolean)
            .join(" "),
        failure_recovery:
          module.search_strategy?.failure_recovery ||
          "如果首轮结果为空，使用备用搜索词缩小到更明确的品类，再继续按预算和排除项筛选。"
      }
    };
  });
}
