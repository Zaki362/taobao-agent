import { runCartExecutor } from "@/lib/agent/cart";
import { runDeepSeekPlanner, runTemplatePlannerForScenario } from "@/lib/agent/planner";
import { runModuleSearch } from "@/lib/agent/product-matcher";
import { getDefaultSceneInput, runSceneParser, sceneSummary } from "@/lib/agent/scene";
import { runRefiner } from "@/lib/agent/refiner";
import { getExecutionBackend } from "@/lib/mcp/client";
import { getSession, saveSession } from "@/lib/session/store";
import { QuickAction, ScenarioId, SceneBrief, SessionState } from "@/lib/session/types";
import { getScenarioConfig } from "@/lib/scenarios";

function generateSessionId() {
  return `session-${Date.now()}`;
}

function createBaseState(rawInput: string, sceneBrief: SceneBrief, deepseekMode: "connected" | "mock", baseTemplate: Awaited<ReturnType<typeof runTemplatePlannerForScenario>>, shoppingPlan: Awaited<ReturnType<typeof runDeepSeekPlanner>>["data"]): SessionState {
  const backend = getExecutionBackend();
  const scenario = getScenarioConfig(sceneBrief.scenario_id);
  return {
    session_id: generateSessionId(),
    raw_input: rawInput,
    scene_brief: sceneBrief,
    base_template: baseTemplate,
    shopping_plan: shoppingPlan,
    module_candidates: {},
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

export async function initializeSession(rawInput = getDefaultSceneInput(), scenarioId: ScenarioId = "new-car") {
  const parsed = await runSceneParser(rawInput, scenarioId);
  const baseTemplate = await runTemplatePlannerForScenario(parsed.data);
  const planned = await runDeepSeekPlanner(parsed.data);
  const state = createBaseState(rawInput, parsed.data, parsed.mode, baseTemplate, planned.data);

  saveSession(state);
  return state;
}

export async function createSessionFromScene(rawInput: string, sceneBrief: SceneBrief, deepseekMode: "connected" | "mock" = "mock") {
  const baseTemplate = await runTemplatePlannerForScenario(sceneBrief);
  const planned = await runDeepSeekPlanner(sceneBrief);
  const state = createBaseState(rawInput, sceneBrief, deepseekMode === "connected" || planned.mode === "connected" ? "connected" : "mock", baseTemplate, planned.data);
  saveSession(state);
  return state;
}

export async function ensureSession(sessionId?: string) {
  if (!sessionId) {
    return null;
  }
  const existing = getSession(sessionId);
  if (existing) {
    return existing;
  }
  return null;
}

export async function parseOnly(rawInput: unknown, scenarioId: ScenarioId = "new-car") {
  const parsed = await runSceneParser(rawInput, scenarioId);
  return parsed;
}

export async function planOnly(rawInput: string, sessionId?: string) {
  const state = sessionId ? await ensureSession(sessionId) : await initializeSession(rawInput);
  if (!state) {
    throw new Error("session not found");
  }
  saveSession(state);
  return state;
}

export async function refineSession(sessionId: string, action: QuickAction) {
  const state = await ensureSession(sessionId);
  if (!state) {
    throw new Error("session not found");
  }
  const refined = await runRefiner(state, action);

  state.current_scene_label = sceneSummary(state.scene_brief);
  saveSession(state);
  return {
    state,
    impactedModules: refined.impactedModules
  };
}

export async function searchModule(sessionId: string, moduleId: string) {
  const state = await ensureSession(sessionId);
  if (!state) {
    throw new Error("session not found");
  }
  const candidates = await runModuleSearch(state, moduleId);
  saveSession(state);
  return {
    state,
    candidates
  };
}

export async function addToCart(sessionId: string, productId: string) {
  const state = await ensureSession(sessionId);
  if (!state) {
    throw new Error("session not found");
  }
  const result = await runCartExecutor(state, productId);
  saveSession(state);
  return {
    state,
    result
  };
}
