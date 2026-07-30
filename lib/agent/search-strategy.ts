import { searchIntentForModule } from "@/lib/agent/search-intents";
import { SceneBrief, ShoppingPlanModule } from "@/lib/session/types";
import { getScenarioConfig } from "@/lib/scenarios";

function compactKeyword(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function moduleAnchorTerms(module: ShoppingPlanModule) {
  return [module.module_name, ...module.typical_item_types]
    .map((term) => compactKeyword(term))
    .filter(Boolean)
    .filter((term, index, list) => list.indexOf(term) === index);
}

function countAnchorMatches(keyword: string, module: ShoppingPlanModule) {
  return moduleAnchorTerms(module).filter((term) => keyword.includes(term)).length;
}

function ensureModuleAnchors(keyword: string, module: ShoppingPlanModule, minAnchors = 1) {
  const anchors = moduleAnchorTerms(module);
  const missingAnchors = anchors.filter((term) => !keyword.includes(term));
  let repaired = compactKeyword(keyword);

  while (countAnchorMatches(repaired, module) < minAnchors && missingAnchors.length > 0) {
    repaired = compactKeyword(`${repaired} ${missingAnchors.shift()}`);
  }

  return repaired;
}

function keywordSignature(scene: SceneBrief, module: ShoppingPlanModule, keyword: string) {
  const scenario = getScenarioConfig(scene.scenario_id);
  const anchors = moduleAnchorTerms(module).filter((term) => keyword.includes(term));
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
  let repaired = ensureModuleAnchors(compactKeyword(keyword), module, 1);
  let signature = keywordSignature(scene, module, repaired);

  if (!signature || seenSignatures.has(signature)) {
    repaired = ensureModuleAnchors(compactKeyword(`${repaired} ${module.module_name}`), module, 2);
    signature = keywordSignature(scene, module, repaired);
  }

  if (!signature || seenSignatures.has(signature)) {
    const extraAnchor = module.typical_item_types.find((term) => term && !repaired.includes(term));
    repaired = compactKeyword(`${repaired} ${extraAnchor ?? module.module_name}`);
    signature = keywordSignature(scene, module, repaired) || repaired;
  }

  seenSignatures.add(signature);
  return repaired;
}

function normalizeAlternateKeywords(
  scene: SceneBrief,
  module: ShoppingPlanModule,
  primaryKeyword: string
) {
  const preference = scene.priority_style.replace("优先", "");
  const generatedAlternates = module.typical_item_types
    .slice(0, 4)
    .map((term) => [scene.vehicle_type, term, preference]
      .filter(Boolean)
      .join(" "));
  const rawAlternates = [
    ...(module.search_strategy?.alternate_keywords ?? []),
    ...generatedAlternates,
    [scene.vehicle_type, module.module_name, module.typical_item_types.slice(0, 2).join(" ")]
      .filter(Boolean)
      .join(" ")
  ];

  return rawAlternates
    .map((item) => ensureModuleAnchors(compactKeyword(item), module, 1))
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
    const alternateKeywords = normalizeAlternateKeywords(scene, module, keyword);
    const distinctivenessNote =
      keyword !== compactKeyword(rawKeyword)
        ? "已补充模块专属品类词，避免与其他模块搜索重复。"
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

