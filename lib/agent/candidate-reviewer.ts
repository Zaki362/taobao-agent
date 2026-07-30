import {
  ModuleCandidateReview,
  ProductCandidate,
  SessionState,
  ShoppingPlanModule
} from "@/lib/session/types";
import { reviewCandidatePool } from "@/lib/llm/deepseek";

function uniqueValues(values: string[]) {
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)));
}

function countWithinBudget(candidates: ProductCandidate[], moduleBudget: number) {
  if (!Number.isFinite(moduleBudget) || moduleBudget <= 0) {
    return 0;
  }

  return candidates.filter((product) => product.price > 0 && product.price <= moduleBudget).length;
}

function firstAvailableKeyword(module: ShoppingPlanModule) {
  return module.search_strategy?.alternate_keywords?.[0] || module.search_keyword || module.search_strategy?.primary_keyword;
}

function candidateText(product: ProductCandidate) {
  return `${product.title} ${product.shop_name} ${product.shop_badges.join(" ")} ${product.highlights.join(" ")}`;
}

export function reviewModuleCandidates(
  state: SessionState,
  module: ShoppingPlanModule,
  candidates: ProductCandidate[]
): ModuleCandidateReview {
  const recommendationTypes = uniqueValues(candidates.map((product) => product.recommendation_type));
  const trustedShopCount = candidates.filter((product) =>
    `${product.shop_name} ${product.shop_badges.join(" ")}`.includes("旗舰店") ||
    `${product.shop_name} ${product.shop_badges.join(" ")}`.includes("官方")
  ).length;
  const withinBudgetCount = countWithinBudget(candidates, module.budget_allocation);
  const missingDetailCount = candidates.filter((product) => !product.detail_url || !product.image_url).length;
  const mustHaveSignals = module.search_strategy?.must_have_signals ?? [];
  const rejectSignals = module.search_strategy?.reject_signals ?? [];
  const qualityChecks = module.search_strategy?.quality_checks ?? [];
  const matchedMustHaveSignals = uniqueValues(
    mustHaveSignals.filter((signal) => candidates.some((product) => candidateText(product).includes(signal)))
  );
  const rejectHit = candidates.some((product) =>
    rejectSignals.some((signal) => signal && candidateText(product).includes(signal))
  );
  const strengths: string[] = [];
  const caveats: string[] = [];

  if (candidates.length === 0) {
    return {
      module_id: module.module_id,
      status: "thin",
      source: "heuristic",
      summary: `「${module.module_name}」暂未形成可展示候选池。`,
      strengths: [],
      caveats: [
        module.search_strategy?.failure_recovery ||
          "首轮搜索没有拿到足够结果，建议换用更明确的品类词。"
      ],
      next_action: "建议使用备用搜索词补搜，或先跳过该模块继续处理其他模块。",
      suggested_keyword: firstAvailableKeyword(module),
      generated_at: new Date().toISOString()
    };
  }

  if (recommendationTypes.length >= 3) {
    strengths.push("已覆盖稳妥、性价比、升级三个推荐档位");
  } else {
    caveats.push("推荐档位还不完整，可能需要补一批候选。");
  }

  if (withinBudgetCount > 0) {
    strengths.push(`${withinBudgetCount} 个候选价格落在模块预算内`);
  } else {
    caveats.push("候选价格与模块预算贴合度偏弱，建议查看详情前先确认是否接受。");
  }

  if (trustedShopCount > 0) {
    strengths.push("候选中包含旗舰店/官方等相对可信店铺信号");
  }

  if (matchedMustHaveSignals.length > 0) {
    strengths.push(`命中 AI 验收信号：${matchedMustHaveSignals.slice(0, 3).join("、")}`);
  } else if (mustHaveSignals.length > 0) {
    caveats.push(`候选暂未明显命中 AI 设定的验收信号：${mustHaveSignals.slice(0, 3).join("、")}。`);
  }

  if (missingDetailCount > 0) {
    caveats.push("部分候选缺少图片或详情链接，建议优先查看信息完整的商品。");
  }

  if (qualityChecks.length > 0 && missingDetailCount > 0) {
    caveats.push(`需要补充核查：${qualityChecks.slice(0, 3).join("、")}。`);
  }

  const excludeHit = candidates.some((product) =>
    module.search_strategy?.exclude_terms?.some((term) =>
      term && candidateText(product).includes(term)
    )
  );
  if (excludeHit || rejectHit) {
    caveats.push("有候选可能触及已有物品或排除项，已在排序中降权但仍建议人工确认。");
  }

  const status =
    recommendationTypes.length < 2
      ? "thin"
      : caveats.length >= 2
        ? "needs_detail_check"
        : "ready";

  return {
    module_id: module.module_id,
    status,
    source: "heuristic",
    summary:
      status === "ready"
        ? `「${module.module_name}」候选池质量可用，可以进入商品详情确认规格。`
        : `「${module.module_name}」已有候选，但仍建议带着风险点逐项确认。`,
    strengths: strengths.length ? strengths : ["已根据当前模块策略形成候选池"],
    caveats: caveats.length ? caveats : ["当前为搜索摘要级判断，最终规格和适配性仍以淘宝详情页为准。"],
    next_action:
      status === "ready"
        ? "建议优先查看稳妥推荐或性价比推荐的淘宝详情。"
        : module.search_strategy?.failure_recovery || "建议先查看详情确认规格，必要时使用备用词补搜。",
    suggested_keyword:
      status === "thin"
        ? [firstAvailableKeyword(module), ...mustHaveSignals.slice(0, 2)]
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
        : undefined,
    generated_at: new Date().toISOString()
  };
}

export async function reviewModuleCandidatesWithAgent(
  state: SessionState,
  module: ShoppingPlanModule,
  candidates: ProductCandidate[]
) {
  const fallbackReview = reviewModuleCandidates(state, module, candidates);
  const result = await reviewCandidatePool({
    scene: state.scene_brief,
    module,
    candidates,
    fallbackReview
  });

  return result.data;
}
