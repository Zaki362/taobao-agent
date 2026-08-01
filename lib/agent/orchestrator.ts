import { runCartExecutor } from "@/lib/agent/cart";
import { consumeAgentDecision, pendingAgentDecision, recordAgentDecision, removeModuleAgentDecisions } from "@/lib/agent/decision-engine";
import {
  applyBudgetReallocationSuggestion,
  buildMarketFeedback,
  refreshMarketFeedback
} from "@/lib/agent/market-feedback";
import { decideNextAgentActionV2 } from "@/lib/agent/runtime-v2";
import { AgentDirectiveProfile, applyAgentDirectiveProfile } from "@/lib/agent/directives";
import { runDeepSeekPlanner, runTemplatePlannerForScenario } from "@/lib/agent/planner";
import { reviewPlanWithAgent } from "@/lib/agent/plan-reviewer";
import { runModuleSearch } from "@/lib/agent/product-matcher";
import { getDefaultSceneInput, runSceneParser, sceneSummary } from "@/lib/agent/scene";
import { runRefiner } from "@/lib/agent/refiner";
import { getExecutionBackend } from "@/lib/mcp/client";
import { loadSession, persistSession } from "@/lib/session/repository";
import { ModuleSearchStrategy, PlanQualityReview, QuickAction, ScenarioId, SceneBrief, SessionState } from "@/lib/session/types";
import { getScenarioConfig } from "@/lib/scenarios";

function generateSessionId() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createBaseState(
  rawInput: string,
  sceneBrief: SceneBrief,
  deepseekMode: "connected" | "mock",
  baseTemplate: Awaited<ReturnType<typeof runTemplatePlannerForScenario>>,
  shoppingPlan: Awaited<ReturnType<typeof runDeepSeekPlanner>>["data"],
  planReview: PlanQualityReview,
  ownerId?: string
): SessionState {
  const backend = getExecutionBackend();
  const scenario = getScenarioConfig(sceneBrief.scenario_id);
  return {
    session_id: generateSessionId(),
    owner_id: ownerId,
    raw_input: rawInput,
    scene_brief: sceneBrief,
    base_template: baseTemplate,
    shopping_plan: shoppingPlan,
    plan_review: planReview,
    module_candidates: {},
    module_reviews: {},
    module_search_traces: {},
    market_feedback: buildMarketFeedback({
      scene_brief: sceneBrief,
      shopping_plan: shoppingPlan,
      module_candidates: {}
    }),
    agent_decisions: [],
    agent_runtime: {
      max_tool_calls: 12,
      used_tool_calls: 0,
      model_decisions: 0,
      policy_decisions: 0,
      model_proposals: 0,
      model_rejections: 0,
      model_failures: 0,
      total_decision_latency_ms: 0,
      last_decision_mode: "none",
      workflow_status: "idle",
      auto_continue: false,
      continuation_count: 0,
      workflow_message: "等待用户确认规划并开始搜索",
      initialized_at: new Date().toISOString()
    },
    selected_items: [],
    tool_logs: [],
    hosted_tasks: [],
    execution_mode: backend,
    permissions_scope:
      backend === "codex_hosted"
        ? ["Codex 宿主执行淘宝搜索", "Codex 宿主提取商品详情", "加入购物车需显式确认"]
        : ["搜索商品", "浏览商品详情", "提取商品信息", "加入购物车需显式确认"],
    deepseek_status: deepseekMode,
    mcp_status: backend === "codex_hosted" ? "hosted" : "unavailable",
    current_scene_label: `${scenario.name} · ${sceneSummary(sceneBrief)}`
  };
}

export async function initializeSession(
  rawInput = getDefaultSceneInput(),
  scenarioId: ScenarioId = "new-car",
  ownerId?: string
) {
  const parsed = await runSceneParser(rawInput, scenarioId);
  const baseTemplate = await runTemplatePlannerForScenario(parsed.data);
  const planned = await runDeepSeekPlanner(parsed.data);
  const reviewed = await reviewPlanWithAgent(parsed.data, planned.data);
  const state = createBaseState(rawInput, parsed.data, parsed.mode === "connected" || planned.mode === "connected" || reviewed.mode === "connected" ? "connected" : "mock", baseTemplate, planned.data, reviewed.data, ownerId);

  await persistSession(state);
  return state;
}

export async function createSessionFromScene(
  rawInput: string,
  sceneBrief: SceneBrief,
  parseMode: "connected" | "mock" = "mock",
  ownerId?: string
) {
  const baseTemplate = await runTemplatePlannerForScenario(sceneBrief);
  const planned = await runDeepSeekPlanner(sceneBrief);
  const reviewed = await reviewPlanWithAgent(sceneBrief, planned.data);
  const state = createBaseState(rawInput, sceneBrief, parseMode === "connected" || planned.mode === "connected" || reviewed.mode === "connected" ? "connected" : "mock", baseTemplate, planned.data, reviewed.data, ownerId);
  await persistSession(state);
  return state;
}

export async function ensureSession(sessionId?: string, userId?: string) {
  if (!sessionId) {
    return null;
  }
  const existing = await loadSession(sessionId, userId);
  if (existing) {
    return existing;
  }
  return null;
}

export async function parseOnly(rawInput: unknown, scenarioId: ScenarioId = "new-car") {
  const parsed = await runSceneParser(rawInput, scenarioId);
  return parsed;
}

export async function planOnly(rawInput: string, sessionId?: string, userId?: string) {
  const state = sessionId ? await ensureSession(sessionId, userId) : await initializeSession(rawInput, "new-car", userId);
  if (!state) {
    throw new Error("session not found");
  }
  await persistSession(state);
  return state;
}

export async function refineSession(sessionId: string, action: QuickAction, userId?: string) {
  const state = await ensureSession(sessionId, userId);
  if (!state) {
    throw new Error("session not found");
  }
  const refined = await runRefiner(state, action);

  state.current_scene_label = `${getScenarioConfig(state.scene_brief.scenario_id).name} · ${sceneSummary(state.scene_brief)}`;
  await persistSession(state);
  return {
    state,
    impactedModules: refined.impactedModules,
    refinementImpact: refined.refinementImpact
  };
}

export async function searchModule(
  sessionId: string,
  moduleId: string,
  options?: {
    keywordOverride?: string;
  },
  userId?: string
) {
  const state = await ensureSession(sessionId, userId);
  if (!state) {
    throw new Error("session not found");
  }
  const candidates = await runModuleSearch(state, moduleId, options);
  consumeAgentDecision(state, moduleId);
  await persistSession(state);
  return {
    state,
    candidates
  };
}

export async function getNextAgentAction(sessionId: string, userId?: string) {
  const state = await ensureSession(sessionId, userId);
  if (!state) {
    throw new Error("session not found");
  }

  const pending = pendingAgentDecision(state);
  const decision = pending ?? recordAgentDecision(state, await decideNextAgentActionV2(state));
  await persistSession(state);
  return {
    state,
    decision
  };
}

export async function addToCart(sessionId: string, productId: string, userId?: string) {
  const state = await ensureSession(sessionId, userId);
  if (!state) {
    throw new Error("session not found");
  }
  const result = await runCartExecutor(state, productId);
  await persistSession(state);
  return {
    state,
    result
  };
}

export async function updateAgentDirectiveProfile(sessionId: string, profile: AgentDirectiveProfile, userId?: string) {
  const state = await ensureSession(sessionId, userId);
  if (!state) {
    throw new Error("session not found");
  }
  const directives = applyAgentDirectiveProfile(state, profile);
  await persistSession(state);
  return {
    state,
    directives
  };
}

export async function updateModuleSearchStrategy(
  sessionId: string,
  moduleId: string,
  payload: {
    primaryKeyword: string;
    alternateKeywords?: string[];
  },
  userId?: string
) {
  const state = await ensureSession(sessionId, userId);
  if (!state) {
    throw new Error("session not found");
  }

  const module = state.shopping_plan.modules.find((item) => item.module_id === moduleId);
  if (!module) {
    throw new Error("module not found");
  }

  const primaryKeyword = payload.primaryKeyword.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!primaryKeyword) {
    throw new Error("primary keyword is required");
  }

  const alternateKeywords = (payload.alternateKeywords ?? [])
    .map((item) => item.replace(/\s+/g, " ").trim().slice(0, 80))
    .filter(Boolean)
    .filter((item, index, list) => item !== primaryKeyword && list.indexOf(item) === index)
    .slice(0, 4);

  const previousStrategy = module.search_strategy;
  const nextStrategy: ModuleSearchStrategy = {
    primary_keyword: primaryKeyword,
    alternate_keywords: alternateKeywords.length
      ? alternateKeywords
      : previousStrategy?.alternate_keywords ?? [],
    include_terms:
      previousStrategy?.include_terms?.length
        ? previousStrategy.include_terms
        : module.typical_item_types.slice(0, 3),
    exclude_terms:
      previousStrategy?.exclude_terms?.length
        ? previousStrategy.exclude_terms
        : [...state.scene_brief.avoid_items, ...state.scene_brief.already_have].slice(0, 5),
    ranking_focus:
      previousStrategy?.ranking_focus?.length
        ? previousStrategy.ranking_focus
        : ["匹配模块意图", "价格贴近预算", "店铺可信度"],
    must_have_signals:
      previousStrategy?.must_have_signals?.length
        ? previousStrategy.must_have_signals
        : [module.module_name, ...module.typical_item_types.slice(0, 3)].filter(Boolean).slice(0, 4),
    reject_signals:
      previousStrategy?.reject_signals?.length
        ? previousStrategy.reject_signals
        : [...state.scene_brief.avoid_items, ...state.scene_brief.already_have].slice(0, 4),
    quality_checks:
      previousStrategy?.quality_checks?.length
        ? previousStrategy.quality_checks
        : ["商品图片完整", "详情链接可打开", "店铺信息明确", "规格描述清楚"],
    price_band:
      previousStrategy?.price_band ||
      `建议控制在模块预算 ${Math.round(module.budget_allocation * 0.35)}-${Math.round(module.budget_allocation * 1.1)} 元附近`,
    reasoning: `用户在规划确认页把「${module.module_name}」首轮搜索词调整为“${primaryKeyword}”，后续搜索将优先按该任务包执行。`,
    failure_recovery:
      previousStrategy?.failure_recovery ||
      "如果首轮结果为空，使用备用搜索词缩小到更明确的品类，再继续按预算和排除项筛选。"
  };

  module.search_keyword = primaryKeyword;
  module.search_strategy = nextStrategy;
  module.status = "refined";
  delete state.module_candidates[moduleId];
  delete state.module_reviews[moduleId];
  delete state.module_search_traces[moduleId];
  removeModuleAgentDecisions(state, moduleId);
  refreshMarketFeedback(state);
  state.agent_runtime.workflow_status = "idle";
  state.agent_runtime.auto_continue = false;
  state.agent_runtime.current_module_id = undefined;
  state.agent_runtime.workflow_message = "搜索策略已更新，等待用户确认后重新开始";
  state.agent_runtime.last_transition_at = new Date().toISOString();
  state.tool_logs.push({
    id: `strategy_update-${Date.now()}`,
    timestamp: new Date().toISOString(),
    tool_name: "agent_update_search_strategy",
    input_summary: `模块：${module.module_name}；首轮搜索词：${primaryKeyword}`,
    output_summary: alternateKeywords.length
      ? `已保存 ${alternateKeywords.length} 个备用搜索词`
      : "已保存主搜索词，备用词沿用 Agent 原策略",
    status: "success",
    duration_ms: 0,
    mode: state.execution_mode
  });

  await persistSession(state);
  return {
    state,
    module
  };
}

export async function applyMarketBudgetSuggestion(
  sessionId: string,
  fromModuleId: string,
  toModuleId: string,
  userId?: string
) {
  const state = await ensureSession(sessionId, userId);
  if (!state) {
    throw new Error("session not found");
  }

  const applied = applyBudgetReallocationSuggestion(state, {
    fromModuleId,
    toModuleId
  });
  await persistSession(state);

  return {
    state,
    ...applied
  };
}
