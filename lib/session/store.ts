import fs from "node:fs";
import path from "node:path";
import { reviewModuleCandidates } from "@/lib/agent/candidate-reviewer";
import { buildMarketFeedback } from "@/lib/agent/market-feedback";
import { normalizeSearchKeywords } from "@/lib/agent/search-strategy";
import { mockReviewShoppingPlan } from "@/lib/llm/mock";
import { isAgentBundleAdoptionForReport, isAgentCompletionReport, isAgentDecision, isHostedExecutionTask, isModuleCandidateReview, isModuleSearchTrace, isProductCandidate, isRefinementImpactSummary, isSelectedItem, isSessionLlmCall, isSessionState } from "@/lib/session/guards";
import { AgentDirectives, ModuleCandidateReview, ModuleSearchTrace, PlanExecutionStrategy, PlanQualityReview, ProductCandidate, SelectedItem, SessionState, ShoppingPlanModule } from "@/lib/session/types";

declare global {
  // eslint-disable-next-line no-var
  var __AUTOPREP_SESSION_STORE__: Map<string, SessionState> | undefined;
}

const store = globalThis.__AUTOPREP_SESSION_STORE__ ?? new Map<string, SessionState>();
globalThis.__AUTOPREP_SESSION_STORE__ = store;

const SESSION_DIR = path.join(process.cwd(), ".data", "sessions");
const MAX_TOOL_LOGS = 120;
const MAX_HOSTED_TASKS = 80;
const MAX_SELECTED_ITEMS = 60;
const MAX_MODULE_CANDIDATES = 12;
const MAX_AGENT_DECISIONS = 120;
const MAX_LLM_CALLS = 120;

function ensureSessionDir() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function sessionFile(sessionId: string) {
  ensureSessionDir();
  return path.join(SESSION_DIR, `${sessionId}.json`);
}

function normalizeModuleSearchStrategy(
  state: SessionState,
  module: ShoppingPlanModule
): ShoppingPlanModule {
  const keyword =
    module.search_strategy?.primary_keyword ||
    module.search_keyword ||
    [state.scene_brief.vehicle_type, module.typical_item_types.slice(0, 3).join(" ")]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  const alternateKeywords =
    module.search_strategy?.alternate_keywords?.length
      ? module.search_strategy.alternate_keywords
      : module.typical_item_types
          .slice(1, 4)
          .map((term) => [state.scene_brief.vehicle_type, term, state.scene_brief.priority_style.replace("优先", "")]
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim())
          .filter(Boolean);

  return {
    ...module,
    search_keyword: module.search_keyword || keyword,
    search_strategy: {
      primary_keyword: keyword,
      alternate_keywords: alternateKeywords.filter((item) => item !== keyword).slice(0, 3),
      include_terms: module.search_strategy?.include_terms?.length
        ? module.search_strategy.include_terms
        : module.typical_item_types.slice(0, 3),
      exclude_terms: module.search_strategy?.exclude_terms?.length
        ? module.search_strategy.exclude_terms
        : [...state.scene_brief.avoid_items, ...state.scene_brief.already_have].slice(0, 5),
      ranking_focus: module.search_strategy?.ranking_focus?.length
        ? module.search_strategy.ranking_focus
        : ["匹配模块意图", "价格贴近预算", "店铺可信度"],
      must_have_signals: module.search_strategy?.must_have_signals?.length
        ? module.search_strategy.must_have_signals
        : [module.module_name, ...module.typical_item_types.slice(0, 3)].filter(Boolean).slice(0, 4),
      reject_signals: module.search_strategy?.reject_signals?.length
        ? module.search_strategy.reject_signals
        : [...state.scene_brief.avoid_items, ...state.scene_brief.already_have].slice(0, 4),
      quality_checks: module.search_strategy?.quality_checks?.length
        ? module.search_strategy.quality_checks
        : ["商品图片完整", "详情链接可打开", "店铺信息明确", "规格描述清楚"],
      price_band:
        module.search_strategy?.price_band ||
        `建议控制在模块预算 ${Math.round(module.budget_allocation * 0.35)}-${Math.round(module.budget_allocation * 1.1)} 元附近`,
      reasoning:
        module.search_strategy?.reasoning ||
        `从旧会话恢复时补齐的保守搜索策略，用“${keyword}”作为首轮搜索词。`,
      failure_recovery:
        module.search_strategy?.failure_recovery ||
        "如果首轮结果为空，使用备用品类词进行一次补搜。"
    }
  };
}

function normalizePlanExecutionStrategy(state: SessionState): PlanExecutionStrategy {
  const existing = state.shopping_plan.execution_strategy;
  const moduleIds = state.shopping_plan.modules.map((module) => module.module_id);

  return {
    module_sequence: Array.isArray(existing?.module_sequence) && existing.module_sequence.length
      ? existing.module_sequence.filter((moduleId) => moduleIds.includes(moduleId))
      : moduleIds,
    budget_guardrails: Array.isArray(existing?.budget_guardrails) && existing.budget_guardrails.length
      ? existing.budget_guardrails
      : [`总预算控制在 ${state.scene_brief.budget} 元内，优先保障高频模块。`],
    tradeoffs: Array.isArray(existing?.tradeoffs) && existing.tradeoffs.length
      ? existing.tradeoffs
      : ["低频升级和装饰项默认后置，避免首购阶段预算分散。"],
    search_notes: Array.isArray(existing?.search_notes) && existing.search_notes.length
      ? existing.search_notes
      : ["每个模块使用差异化搜索词，先返回商品摘要，再由用户决定是否进入详情。"],
    stop_rules: Array.isArray(existing?.stop_rules) && existing.stop_rules.length
      ? existing.stop_rules
      : ["每个模块拿到三档候选后停止扩搜，避免无意义等待。"]
  };
}

function normalizeAgentDirectives(state: SessionState): AgentDirectives {
  const existing = (state.shopping_plan as Partial<SessionState["shopping_plan"]>).agent_directives;

  return {
    autonomy_level:
      existing?.autonomy_level === "保守执行" ||
      existing?.autonomy_level === "平衡执行" ||
      existing?.autonomy_level === "探索执行"
        ? existing.autonomy_level
        : state.scene_brief.priority_style === "性价比优先"
          ? "探索执行"
          : "平衡执行",
    search_depth:
      existing?.search_depth === "轻量搜索" ||
      existing?.search_depth === "标准搜索" ||
      existing?.search_depth === "深度搜索"
        ? existing.search_depth
        : state.scene_brief.budget >= 2000
          ? "标准搜索"
          : "轻量搜索",
    detail_policy:
      existing?.detail_policy ||
      "默认先读取搜索摘要，不主动打开大量详情页；只有候选风险较高或用户点击详情时再进入商品页。",
    recovery_policy:
      existing?.recovery_policy ||
      "某个模块搜索失败时，使用备用关键词补搜一次；仍失败则跳过该模块继续后续模块。",
    rerank_rules:
      Array.isArray(existing?.rerank_rules) && existing.rerank_rules.length
        ? existing.rerank_rules
        : ["标题匹配模块意图", "价格贴近模块预算", "店铺可信度更高"],
    user_confirmation_points:
      Array.isArray(existing?.user_confirmation_points) && existing.user_confirmation_points.length
        ? existing.user_confirmation_points
        : ["加入购物车前必须由用户确认"],
    safety_boundaries:
      Array.isArray(existing?.safety_boundaries) && existing.safety_boundaries.length
        ? existing.safety_boundaries
        : ["不读取订单、地址、手机号、聊天记录等敏感数据", "不自动下单或支付"]
  };
}

function normalizePlanQualityReview(state: SessionState): PlanQualityReview {
  const existing = (state as Partial<SessionState>).plan_review;
  const fallback = mockReviewShoppingPlan(state.scene_brief, state.shopping_plan);
  if (!existing || typeof existing !== "object") {
    return fallback;
  }

  return {
    status:
      existing.status === "ready" || existing.status === "needs_attention" || existing.status === "risky"
        ? existing.status
        : fallback.status,
    source: existing.source === "deepseek" ? "deepseek" : "heuristic",
    summary: typeof existing.summary === "string" && existing.summary.trim() ? existing.summary : fallback.summary,
    strengths: Array.isArray(existing.strengths) && existing.strengths.length ? existing.strengths : fallback.strengths,
    risks: Array.isArray(existing.risks) && existing.risks.length ? existing.risks : fallback.risks,
    improvement_suggestions:
      Array.isArray(existing.improvement_suggestions) && existing.improvement_suggestions.length
        ? existing.improvement_suggestions
        : fallback.improvement_suggestions,
    budget_comment:
      typeof existing.budget_comment === "string" && existing.budget_comment.trim()
        ? existing.budget_comment
        : fallback.budget_comment,
    keyword_comment:
      typeof existing.keyword_comment === "string" && existing.keyword_comment.trim()
        ? existing.keyword_comment
        : fallback.keyword_comment,
    module_comment:
      typeof existing.module_comment === "string" && existing.module_comment.trim()
        ? existing.module_comment
        : fallback.module_comment,
    generated_at:
      typeof existing.generated_at === "string" && existing.generated_at.trim()
        ? existing.generated_at
        : fallback.generated_at
  };
}

function normalizeModuleCandidates(
  state: SessionState,
  modules: ShoppingPlanModule[]
): Record<string, ProductCandidate[]> {
  const rawCandidates = state.module_candidates as Record<string, unknown>;
  const normalized: Record<string, ProductCandidate[]> = {};

  for (const module of modules) {
    const moduleCandidates = rawCandidates[module.module_id];
    if (!Array.isArray(moduleCandidates)) {
      continue;
    }

    const seen = new Set<string>();
    const candidates = moduleCandidates
      .filter(isProductCandidate)
      .map((candidate) => ({
        ...candidate,
        module_id: module.module_id
      }))
      .filter((candidate) => {
        if (seen.has(candidate.product_id)) {
          return false;
        }
        seen.add(candidate.product_id);
        return true;
      });

    if (candidates.length > 0) {
      normalized[module.module_id] = candidates.slice(0, MAX_MODULE_CANDIDATES);
    }
  }

  return normalized;
}

function normalizeSelectedItems(state: SessionState): SelectedItem[] {
  if (!Array.isArray(state.selected_items)) {
    return [];
  }

  const seen = new Set<string>();
  return state.selected_items
    .filter(isSelectedItem)
    .filter((item) => {
      if (seen.has(item.product_id)) {
        return false;
      }
      seen.add(item.product_id);
      return true;
    })
    .slice(0, MAX_SELECTED_ITEMS);
}

function normalizeModuleReviews(
  state: SessionState,
  modules: ShoppingPlanModule[],
  normalizedCandidates: Record<string, ProductCandidate[]>
): Record<string, ModuleCandidateReview> {
  const rawReviews = state.module_reviews as Record<string, unknown> | undefined;
  const normalized: Record<string, ModuleCandidateReview> = {};

  for (const module of modules) {
    const existingReview = rawReviews?.[module.module_id];
    if (
      isModuleCandidateReview(existingReview) &&
      existingReview.module_id === module.module_id
    ) {
      normalized[module.module_id] = existingReview;
      continue;
    }

    if (Array.isArray(normalizedCandidates[module.module_id])) {
      normalized[module.module_id] = reviewModuleCandidates(
        state,
        module,
        normalizedCandidates[module.module_id] ?? []
      );
    }
  }

  return normalized;
}

function traceStatusFromReview(review?: ModuleCandidateReview): ModuleSearchTrace["status"] {
  if (!review) {
    return "thin";
  }
  if (review.status === "ready") {
    return "ready";
  }
  if (review.status === "thin" || review.status === "needs_refine") {
    return "thin";
  }
  return "recovered";
}

function normalizeModuleSearchTraces(
  state: SessionState,
  modules: ShoppingPlanModule[],
  normalizedCandidates: Record<string, ProductCandidate[]>,
  moduleReviews: Record<string, ModuleCandidateReview>
): Record<string, ModuleSearchTrace> {
  const rawTraces = (state as Partial<SessionState>).module_search_traces as Record<string, unknown> | undefined;
  const normalized: Record<string, ModuleSearchTrace> = {};

  for (const module of modules) {
    const existingTrace = rawTraces?.[module.module_id];
    if (
      isModuleSearchTrace(existingTrace) &&
      existingTrace.module_id === module.module_id
    ) {
      normalized[module.module_id] = existingTrace;
      continue;
    }

    const candidates = normalizedCandidates[module.module_id] ?? [];
    if (candidates.length === 0) {
      continue;
    }

    const review = moduleReviews[module.module_id];
    const keyword = module.search_strategy?.primary_keyword || module.search_keyword || module.module_name;
    const now = review?.generated_at ?? new Date().toISOString();
    normalized[module.module_id] = {
      module_id: module.module_id,
      module_name: module.module_name,
      status: traceStatusFromReview(review),
      primary_keyword: keyword,
      searched_keywords: [keyword],
      attempts: [
        {
          keyword,
          reason: "旧会话恢复：根据已有候选池补齐 Agent 搜索轨迹。",
          result_count: candidates.length,
          status: "success",
          created_at: now
        }
      ],
      result_count: candidates.length,
      candidate_count: candidates.length,
      review_status: review?.status,
      review_summary: review?.summary,
      recovery_keyword: review?.suggested_keyword,
      ai_decision_summary:
        review?.summary ||
        `「${module.module_name}」已有 ${candidates.length} 个候选，系统已补齐恢复态决策摘要。`,
      next_action:
        review?.next_action ||
        "继续查看候选商品；如质量偏薄，可使用备用搜索词补搜。",
      generated_at: now,
      updated_at: now
    };
  }

  return normalized;
}

export function normalizeSessionState(state: SessionState): SessionState {
  const completionReport = isAgentCompletionReport((state as Partial<SessionState>).completion_report)
    ? (state as Partial<SessionState>).completion_report
    : undefined;
  const bundleAdoption = isAgentBundleAdoptionForReport(
    (state as Partial<SessionState>).bundle_adoption,
    completionReport
  )
    ? (state as Partial<SessionState>).bundle_adoption
    : undefined;
  const shoppingPlan = {
    ...state.shopping_plan,
    modules: normalizeSearchKeywords(
      state.scene_brief,
      Array.isArray(state.shopping_plan?.modules)
        ? state.shopping_plan.modules.map((module) => normalizeModuleSearchStrategy(state, module))
        : []
    )
  };
  const stateWithNormalizedModules = {
    ...state,
    shopping_plan: shoppingPlan
  };
  const normalizedModuleCandidates = normalizeModuleCandidates(stateWithNormalizedModules, shoppingPlan.modules);
  const stateWithNormalizedCandidates = {
    ...stateWithNormalizedModules,
    module_candidates: normalizedModuleCandidates
  };
  const moduleReviews = normalizeModuleReviews(
    stateWithNormalizedCandidates,
    shoppingPlan.modules,
    normalizedModuleCandidates
  );
  const moduleSearchTraces = normalizeModuleSearchTraces(
    stateWithNormalizedCandidates,
    shoppingPlan.modules,
    normalizedModuleCandidates,
    moduleReviews
  );

  return {
    ...state,
    archived_at:
      typeof (state as Partial<SessionState>).archived_at === "string" &&
      (state as Partial<SessionState>).archived_at?.trim()
        ? (state as Partial<SessionState>).archived_at
        : undefined,
    archived_from_workflow_status:
      (state as Partial<SessionState>).archived_from_workflow_status === "idle" ||
      (state as Partial<SessionState>).archived_from_workflow_status === "running" ||
      (state as Partial<SessionState>).archived_from_workflow_status === "waiting_for_tools" ||
      (state as Partial<SessionState>).archived_from_workflow_status === "completed" ||
      (state as Partial<SessionState>).archived_from_workflow_status === "paused" ||
      (state as Partial<SessionState>).archived_from_workflow_status === "error"
        ? (state as Partial<SessionState>).archived_from_workflow_status
        : undefined,
    shopping_plan: {
      ...shoppingPlan,
      execution_strategy: normalizePlanExecutionStrategy(stateWithNormalizedModules),
      agent_directives: normalizeAgentDirectives(stateWithNormalizedModules)
    },
    plan_review: normalizePlanQualityReview(stateWithNormalizedModules),
    module_candidates: normalizedModuleCandidates,
    module_reviews: moduleReviews,
    module_search_traces: moduleSearchTraces,
    market_feedback: buildMarketFeedback(stateWithNormalizedCandidates),
    agent_decisions: Array.isArray((state as Partial<SessionState>).agent_decisions)
      ? ((state as Partial<SessionState>).agent_decisions ?? []).filter(isAgentDecision).slice(-MAX_AGENT_DECISIONS)
      : [],
    agent_runtime: {
      max_tool_calls: Number.isFinite((state as Partial<SessionState>).agent_runtime?.max_tool_calls)
        ? Math.max(1, Math.round((state as Partial<SessionState>).agent_runtime?.max_tool_calls ?? 12))
        : 12,
      used_tool_calls: Number.isFinite((state as Partial<SessionState>).agent_runtime?.used_tool_calls)
        ? Math.max(0, Math.round((state as Partial<SessionState>).agent_runtime?.used_tool_calls ?? 0))
        : 0,
      model_decisions: Number.isFinite((state as Partial<SessionState>).agent_runtime?.model_decisions)
        ? Math.max(0, Math.round((state as Partial<SessionState>).agent_runtime?.model_decisions ?? 0))
        : 0,
      policy_decisions: Number.isFinite((state as Partial<SessionState>).agent_runtime?.policy_decisions)
        ? Math.max(0, Math.round((state as Partial<SessionState>).agent_runtime?.policy_decisions ?? 0))
        : 0,
      model_proposals: Number.isFinite((state as Partial<SessionState>).agent_runtime?.model_proposals)
        ? Math.max(0, Math.round((state as Partial<SessionState>).agent_runtime?.model_proposals ?? 0))
        : 0,
      model_rejections: Number.isFinite((state as Partial<SessionState>).agent_runtime?.model_rejections)
        ? Math.max(0, Math.round((state as Partial<SessionState>).agent_runtime?.model_rejections ?? 0))
        : 0,
      model_failures: Number.isFinite((state as Partial<SessionState>).agent_runtime?.model_failures)
        ? Math.max(0, Math.round((state as Partial<SessionState>).agent_runtime?.model_failures ?? 0))
        : 0,
      total_decision_latency_ms: Number.isFinite((state as Partial<SessionState>).agent_runtime?.total_decision_latency_ms)
        ? Math.max(0, Math.round((state as Partial<SessionState>).agent_runtime?.total_decision_latency_ms ?? 0))
        : 0,
      last_fallback_reason:
        typeof (state as Partial<SessionState>).agent_runtime?.last_fallback_reason === "string"
          ? (state as Partial<SessionState>).agent_runtime?.last_fallback_reason
          : undefined,
      last_decision_at:
        typeof (state as Partial<SessionState>).agent_runtime?.last_decision_at === "string"
          ? (state as Partial<SessionState>).agent_runtime?.last_decision_at
          : undefined,
      last_decision_mode:
        (state as Partial<SessionState>).agent_runtime?.last_decision_mode === "deepseek" ||
        (state as Partial<SessionState>).agent_runtime?.last_decision_mode === "policy"
          ? (state as Partial<SessionState>).agent_runtime!.last_decision_mode
          : "none",
      workflow_status:
        (state as Partial<SessionState>).agent_runtime?.workflow_status === "running" ||
        (state as Partial<SessionState>).agent_runtime?.workflow_status === "waiting_for_tools" ||
        (state as Partial<SessionState>).agent_runtime?.workflow_status === "completed" ||
        (state as Partial<SessionState>).agent_runtime?.workflow_status === "paused" ||
        (state as Partial<SessionState>).agent_runtime?.workflow_status === "error"
          ? (state as Partial<SessionState>).agent_runtime!.workflow_status
          : "idle",
      auto_continue: (state as Partial<SessionState>).agent_runtime?.auto_continue === true,
      workflow_run_id:
        typeof (state as Partial<SessionState>).agent_runtime?.workflow_run_id === "string"
          ? (state as Partial<SessionState>).agent_runtime?.workflow_run_id
          : undefined,
      current_module_id:
        typeof (state as Partial<SessionState>).agent_runtime?.current_module_id === "string"
          ? (state as Partial<SessionState>).agent_runtime?.current_module_id
          : undefined,
      continuation_count: Number.isFinite((state as Partial<SessionState>).agent_runtime?.continuation_count)
        ? Math.max(0, Math.round((state as Partial<SessionState>).agent_runtime?.continuation_count ?? 0))
        : 0,
      workflow_message:
        typeof (state as Partial<SessionState>).agent_runtime?.workflow_message === "string"
          ? (state as Partial<SessionState>).agent_runtime!.workflow_message
          : "等待用户开始搜索",
      last_transition_at:
        typeof (state as Partial<SessionState>).agent_runtime?.last_transition_at === "string"
          ? (state as Partial<SessionState>).agent_runtime?.last_transition_at
          : undefined,
      initialized_at:
        (state as Partial<SessionState>).agent_runtime?.initialized_at ?? new Date().toISOString()
    },
    llm_calls: Array.isArray((state as Partial<SessionState>).llm_calls)
      ? ((state as Partial<SessionState>).llm_calls ?? []).filter(isSessionLlmCall).slice(-MAX_LLM_CALLS)
      : [],
    completion_report: completionReport,
    bundle_adoption: bundleAdoption,
    selected_items: normalizeSelectedItems(state),
    tool_logs: Array.isArray(state.tool_logs) ? state.tool_logs.slice(0, MAX_TOOL_LOGS) : [],
    hosted_tasks: Array.isArray((state as Partial<SessionState>).hosted_tasks)
      ? ((state as Partial<SessionState>).hosted_tasks ?? []).filter(isHostedExecutionTask).slice(0, MAX_HOSTED_TASKS)
      : [],
    last_refinement: isRefinementImpactSummary((state as Partial<SessionState>).last_refinement)
      ? (state as Partial<SessionState>).last_refinement
      : undefined,
    execution_mode: state.execution_mode ?? "local_executor",
    permissions_scope: Array.isArray(state.permissions_scope) ? state.permissions_scope : [],
    deepseek_status: state.deepseek_status ?? "mock",
    mcp_status: state.mcp_status ?? "unavailable",
    current_scene_label: state.current_scene_label ?? state.scene_brief.scene_type
  };
}

function readSessionFromDisk(sessionId: string) {
  const file = sessionFile(sessionId);
  if (!fs.existsSync(file)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isSessionState(parsed)) {
      return null;
    }
    return normalizeSessionState(parsed);
  } catch (error) {
    console.warn(
      `[session-store] failed to read session ${sessionId}: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
    return null;
  }
}

export function getSession(sessionId: string) {
  const inMemory = store.get(sessionId);
  if (inMemory) {
    const normalized = normalizeSessionState(inMemory);
    store.set(sessionId, normalized);
    return normalized;
  }

  const persisted = readSessionFromDisk(sessionId);
  if (persisted) {
    store.set(sessionId, persisted);
    return persisted;
  }

  return null;
}

export function saveSession(state: SessionState) {
  const normalized = normalizeSessionState(state);
  store.set(normalized.session_id, normalized);
  const file = sessionFile(normalized.session_id);
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;

  try {
    fs.writeFileSync(tempFile, JSON.stringify(normalized, null, 2), "utf-8");
    fs.renameSync(tempFile, file);
  } catch (error) {
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch {
      // Ignore cleanup failures; the original write error is more useful.
    }

    throw error;
  }

  return normalized;
}

export function listSessions() {
  ensureSessionDir();
  const fromDisk = fs
    .readdirSync(SESSION_DIR)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => readSessionFromDisk(entry.replace(/\.json$/, "")))
    .filter((item): item is SessionState => Boolean(item));

  for (const session of fromDisk) {
    store.set(session.session_id, session);
  }

  return Array.from(store.values());
}
