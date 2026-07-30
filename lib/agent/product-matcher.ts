import { getExecutionBackend } from "@/lib/mcp/client";
import { reviewModuleCandidatesWithAgent } from "@/lib/agent/candidate-reviewer";
import { executeMcpTool } from "@/lib/mcp/executor";
import { queueModuleSearchTask } from "@/lib/mcp/hosted";
import { rankCandidatesForModule } from "@/lib/agent/candidate-ranker";
import { searchIntentForModule } from "@/lib/agent/search-intents";
import { SearchResultItem } from "@/lib/mcp/types";
import { ModuleCandidateReview, ModuleSearchAttempt, ModuleSearchTrace, ProductCandidate, SessionState, ShoppingPlanModule } from "@/lib/session/types";
import { getScenarioConfig } from "@/lib/scenarios";
import { enqueueModuleSearchJob } from "@/lib/runtime/jobs";

function truncateSentence(text: string, maxLength = 58) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength)}...`;
}

function buildFastFitReason(
  state: SessionState,
  module: ShoppingPlanModule,
  title: string,
  recommendationType: ProductCandidate["recommendation_type"],
  rankReasons: string[] = []
) {
  const scenario = getScenarioConfig(state.scene_brief.scenario_id);
  const recommendationFrame = scenario.product_reason_style[recommendationType];
  const strategy = module.recommendation_strategy || module.rationale;
  const aiFocus = module.search_strategy?.ranking_focus?.slice(0, 2).join("、");
  const acceptanceSignals = module.search_strategy?.must_have_signals?.slice(0, 2).join("、");
  const rankingExplanation =
    rankReasons.length > 0
      ? `系统优先看中了它的${rankReasons.join("、")}。`
      : "系统将它作为当前模块的备选项保留。";
  const focusExplanation = aiFocus ? `本轮AI排序重点是${aiFocus}。` : "";
  const acceptanceExplanation = acceptanceSignals ? `验收时会重点核对${acceptanceSignals}。` : "";
  const strategyExplanation = strategy
    ? `整体上符合本模块“${truncateSentence(strategy, 52)}”的筛选方向。`
    : "";

  return `适合「${module.module_name}」：${recommendationFrame}${rankingExplanation}${focusExplanation}${acceptanceExplanation}${strategyExplanation}`;
}

function buildSearchKeywordQueue(
  state: SessionState,
  module: ShoppingPlanModule,
  keywordOverride?: string
) {
  const primary = module.search_strategy?.primary_keyword || module.search_keyword || searchIntentForModule(state.scene_brief, module);
  const alternates = (module.search_strategy?.alternate_keywords ?? [])
    .map((keyword) => keyword.replace(/\s+/g, " ").trim())
    .filter((keyword) => keyword && keyword !== primary);
  const override = keywordOverride?.replace(/\s+/g, " ").trim();
  const previousReview = state.module_reviews[module.module_id];
  const reviewSuggestedKeyword =
    previousReview &&
    (previousReview.status === "thin" || previousReview.status === "needs_refine") &&
    previousReview.suggested_keyword
      ? previousReview.suggested_keyword.replace(/\s+/g, " ").trim()
      : "";
  const orderedKeywords = override
    ? [override, reviewSuggestedKeyword, primary, ...alternates]
    : state.last_action === "换一批推荐" && alternates.length > 0
      ? [alternates[0], reviewSuggestedKeyword, primary, ...alternates.slice(1)]
      : [reviewSuggestedKeyword, primary, ...alternates];

  return orderedKeywords
    .filter(Boolean)
    .filter((keyword, index, list) => list.indexOf(keyword) === index);
}

function keywordAttemptReason(
  state: SessionState,
  module: ShoppingPlanModule,
  keyword: string,
  index: number,
  keywordOverride?: string
) {
  if (keywordOverride && keyword === keywordOverride) {
    return "用户或候选池复盘指定的补搜词，优先验证该方向。";
  }

  if (index === 0 && keyword === module.search_strategy?.primary_keyword) {
    return module.search_strategy?.reasoning || "使用 AI 规划阶段给出的首轮主搜索词。";
  }

  if (keyword === module.search_keyword) {
    return "使用模块规划中的搜索意图词，保证与当前模块强相关。";
  }

  if (keyword === state.module_reviews[module.module_id]?.suggested_keyword) {
    return "候选池复盘认为结果偏薄，按建议关键词进行恢复搜索。";
  }

  return "使用 AI 规划阶段给出的备用搜索词，扩大但不偏离模块范围。";
}

function maxSearchAttempts(state: SessionState) {
  const searchDepth = state.shopping_plan.agent_directives.search_depth;
  const autonomyLevel = state.shopping_plan.agent_directives.autonomy_level;
  const autonomyBonus = autonomyLevel === "探索执行" ? 1 : 0;
  const autonomyCap = autonomyLevel === "保守执行" ? 1 : 3;
  if (searchDepth === "深度搜索") {
    return Math.min(autonomyCap, 3 + autonomyBonus);
  }
  if (searchDepth === "标准搜索") {
    return Math.min(autonomyCap, 2 + autonomyBonus);
  }
  return 1;
}

function shouldTryAdditionalSearch(
  state: SessionState,
  currentResultCount: number,
  completedAttempts: number,
  queueLength: number
) {
  if (completedAttempts >= Math.min(maxSearchAttempts(state), queueLength)) {
    return false;
  }

  const searchDepth = state.shopping_plan.agent_directives.search_depth;
  if (searchDepth === "深度搜索") {
    return currentResultCount < 8;
  }
  if (searchDepth === "标准搜索") {
    return currentResultCount < 4;
  }
  return currentResultCount === 0;
}

function shouldUseReviewSuggestion(
  state: SessionState,
  review: ModuleCandidateReview,
  searchedKeywords: Set<string>,
  candidateCount: number
) {
  const suggestedKeyword = review.suggested_keyword?.replace(/\s+/g, " ").trim();
  if (!suggestedKeyword || searchedKeywords.has(suggestedKeyword)) {
    return false;
  }

  if (searchedKeywords.size >= maxSearchAttempts(state)) {
    return false;
  }

  if (state.shopping_plan.agent_directives.search_depth === "轻量搜索") {
    return candidateCount === 0;
  }

  return review.status === "thin" || review.status === "needs_refine";
}

function mergeSearchResults<T extends { product_id: string }>(primary: T[], secondary: T[]) {
  const seen = new Set<string>();
  return [...primary, ...secondary].filter((item) => {
    if (!item.product_id || seen.has(item.product_id)) {
      return false;
    }
    seen.add(item.product_id);
    return true;
  });
}

function traceStatusFromReview(
  review: ModuleCandidateReview,
  candidates: ProductCandidate[],
  attempts: ModuleSearchAttempt[],
  recovered: boolean
): ModuleSearchTrace["status"] {
  if (candidates.length === 0 && attempts.some((attempt) => attempt.status === "error")) {
    return "failed";
  }
  if (recovered) {
    return "recovered";
  }
  if (review.status === "ready") {
    return "ready";
  }
  return "thin";
}

function buildTraceSummary({
  module,
  candidates,
  attempts,
  review,
  recoveryKeyword
}: {
  module: ShoppingPlanModule;
  candidates: ProductCandidate[];
  attempts: ModuleSearchAttempt[];
  review: ModuleCandidateReview;
  recoveryKeyword?: string;
}) {
  const successCount = attempts.filter((attempt) => attempt.status === "success").length;
  const errorCount = attempts.filter((attempt) => attempt.status === "error").length;

  if (candidates.length === 0 && errorCount > 0) {
    return `「${module.module_name}」已尝试 ${attempts.length} 个关键词，但工具暂未返回可用候选；系统会保留失败记录，便于稍后换词重试。`;
  }

  if (recoveryKeyword) {
    return `「${module.module_name}」首轮候选复盘后触发补搜，已使用“${recoveryKeyword}”合并候选，当前保留 ${candidates.length} 个商品。`;
  }

  if (successCount > 1) {
    return `「${module.module_name}」按 AI 搜索深度尝试 ${successCount} 轮关键词，合并后保留 ${candidates.length} 个候选。`;
  }

  return review.summary || `「${module.module_name}」已按首轮搜索策略生成 ${candidates.length} 个候选。`;
}

function setModuleSearchTrace({
  state,
  module,
  primaryKeyword,
  attempts,
  candidates,
  review,
  recoveryKeyword
}: {
  state: SessionState;
  module: ShoppingPlanModule;
  primaryKeyword: string;
  attempts: ModuleSearchAttempt[];
  candidates: ProductCandidate[];
  review: ModuleCandidateReview;
  recoveryKeyword?: string;
}) {
  const now = new Date().toISOString();
  const searchedKeywords = attempts
    .filter((attempt) => attempt.status !== "skipped")
    .map((attempt) => attempt.keyword)
    .filter((keyword, index, list) => list.indexOf(keyword) === index);
  const status = traceStatusFromReview(review, candidates, attempts, Boolean(recoveryKeyword));

  state.module_search_traces[module.module_id] = {
    module_id: module.module_id,
    module_name: module.module_name,
    status,
    primary_keyword: primaryKeyword,
    searched_keywords: searchedKeywords,
    attempts,
    result_count: attempts.reduce((sum, attempt) => sum + Math.max(0, attempt.result_count), 0),
    candidate_count: candidates.length,
    review_status: review.status,
    review_summary: review.summary,
    recovery_keyword: recoveryKeyword || review.suggested_keyword,
    ai_decision_summary: buildTraceSummary({ module, candidates, attempts, review, recoveryKeyword }),
    next_action: review.next_action,
    generated_at: state.module_search_traces[module.module_id]?.generated_at ?? now,
    updated_at: now
  };
}

function buildCandidatesFromSearchResults(
  state: SessionState,
  module: ShoppingPlanModule,
  results: SearchResultItem[]
) {
  const rotatedResults =
    state.last_action === "换一批推荐" && results.length > 1
      ? [...results.slice(1), results[0]]
      : results;

  const rankedResults = rankCandidatesForModule(
    state.scene_brief,
    module,
    rotatedResults,
    {
      rerank_rules: state.shopping_plan.agent_directives.rerank_rules,
      budget_guardrails: state.shopping_plan.execution_strategy.budget_guardrails
    }
  );
  const candidates: ProductCandidate[] = [];

  for (const ranked of rankedResults) {
    const item = ranked.item;
    const recommendationType = ranked.recommendation_type;
    const detail = {
      product_id: item.product_id,
      title: item.title,
      price: item.price,
      shop_name: item.shop_name,
      image_url: item.image_url,
      detail_url: item.detail_url,
      shop_badges: item.shop_badges,
      highlights: item.highlights,
      risk_notes: [getScenarioConfig(state.scene_brief.scenario_id).product_risk_style]
    };

    candidates.push({
      product_id: detail.product_id,
      title: detail.title,
      price: detail.price,
      source: "淘宝",
      shop_name: detail.shop_name,
      image_url: detail.image_url,
      detail_url: detail.detail_url,
      shop_badges: detail.shop_badges,
      highlights: [...new Set([...detail.highlights, ...ranked.reasons])].slice(0, 4),
      risk_notes: detail.risk_notes,
      fit_reason: buildFastFitReason(state, module, detail.title, recommendationType, ranked.reasons),
      recommendation_type: recommendationType,
      module_id: module.module_id
    });
  }

  return candidates;
}

export async function runModuleSearch(
  state: SessionState,
  moduleId: string,
  options?: {
    keywordOverride?: string;
  }
) {
  const module = state.shopping_plan.modules.find((item) => item.module_id === moduleId);
  if (!module) {
    throw new Error("module not found");
  }

  const searchKeywordQueue = buildSearchKeywordQueue(state, module, options?.keywordOverride);
  const searchIntent = searchKeywordQueue[0] || searchIntentForModule(state.scene_brief, module);
  const backend = getExecutionBackend();
  if (backend === "codex_hosted" || backend === "local_executor") {
    if (backend === "local_executor") {
      await enqueueModuleSearchJob(state, {
        moduleId: module.module_id,
        moduleName: module.module_name,
        keyword: searchIntent
      });
    } else {
      queueModuleSearchTask(state, {
        module_id: module.module_id,
        module_name: module.module_name,
        search_intent: searchIntent
      });
    }
    const now = new Date().toISOString();
    state.module_search_traces[moduleId] = {
      module_id: module.module_id,
      module_name: module.module_name,
      status: "thin",
      primary_keyword: searchIntent,
      searched_keywords: [searchIntent],
      attempts: [
        {
          keyword: searchIntent,
          reason: backend === "local_executor"
            ? "搜索任务已进入持久化队列，等待本地 Qoder/Taobao 执行器领取。"
            : "当前处于 Codex 宿主代理模式，搜索任务已排队等待宿主执行。",
          result_count: 0,
          status: "skipped",
          created_at: now
        }
      ],
      result_count: 0,
      candidate_count: state.module_candidates[moduleId]?.length ?? 0,
      ai_decision_summary: backend === "local_executor"
        ? `「${module.module_name}」搜索任务已持久化，执行器完成后会自动回填候选池。`
        : `「${module.module_name}」搜索任务已交给宿主代理，等待回填候选池。`,
      next_action: backend === "local_executor" ? "等待本地执行器回填事件。" : "等待宿主代理完成任务并刷新结果。",
      generated_at: state.module_search_traces[moduleId]?.generated_at ?? now,
      updated_at: now
    };
    return state.module_candidates[moduleId] ?? [];
  }

  let mergedResults: SearchResultItem[] = [];
  const searchedKeywords = new Set<string>();
  const attempts: ModuleSearchAttempt[] = [];

  for (const [index, keyword] of searchKeywordQueue.entries()) {
    searchedKeywords.add(keyword);
    try {
      const searchResult = await executeMcpTool(state, "search_taobao_products", {
        keyword,
        module_id: module.module_id
      }, {
        module_id: module.module_id,
        module_name: module.module_name
      });
      attempts.push({
        keyword,
        reason: keywordAttemptReason(state, module, keyword, index, options?.keywordOverride),
        result_count: searchResult.results.length,
        status: "success",
        created_at: new Date().toISOString()
      });
      mergedResults = mergeSearchResults(mergedResults, searchResult.results);
    } catch (error) {
      attempts.push({
        keyword,
        reason: keywordAttemptReason(state, module, keyword, index, options?.keywordOverride),
        result_count: 0,
        status: "error",
        error_message: error instanceof Error ? error.message : "搜索工具调用失败",
        created_at: new Date().toISOString()
      });
    }

    if (!shouldTryAdditionalSearch(state, mergedResults.length, searchedKeywords.size, searchKeywordQueue.length)) {
      break;
    }
  }

  let candidates = buildCandidatesFromSearchResults(state, module, mergedResults);
  let review = await reviewModuleCandidatesWithAgent(state, module, candidates);
  let recoveryKeyword: string | undefined;

  if (shouldUseReviewSuggestion(state, review, searchedKeywords, candidates.length)) {
    const suggestedKeyword = review.suggested_keyword?.replace(/\s+/g, " ").trim();
    if (suggestedKeyword) {
      try {
        const recoveryResult = await executeMcpTool(state, "search_taobao_products", {
          keyword: suggestedKeyword,
          module_id: module.module_id
        }, {
          module_id: module.module_id,
          module_name: module.module_name
        });
        recoveryKeyword = suggestedKeyword;
        attempts.push({
          keyword: suggestedKeyword,
          reason: "候选池复盘后建议补搜，Agent 使用该词做恢复搜索。",
          result_count: recoveryResult.results.length,
          status: "success",
          created_at: new Date().toISOString()
        });
        mergedResults = mergeSearchResults(mergedResults, recoveryResult.results);
        candidates = buildCandidatesFromSearchResults(state, module, mergedResults);
        review = await reviewModuleCandidatesWithAgent(state, module, candidates);
      } catch (error) {
        attempts.push({
          keyword: suggestedKeyword,
          reason: "候选池复盘后建议补搜，但恢复搜索未成功。",
          result_count: 0,
          status: "error",
          error_message: error instanceof Error ? error.message : "恢复搜索工具调用失败",
          created_at: new Date().toISOString()
        });
      }
    }
  }

  state.module_candidates[moduleId] = candidates;
  state.module_reviews[moduleId] = review;
  setModuleSearchTrace({
    state,
    module,
    primaryKeyword: searchIntent,
    attempts,
    candidates,
    review,
    recoveryKeyword
  });
  return candidates;
}
