import { NextRequest } from "next/server";
import { createSessionFromScene, initializeSession, parseOnly } from "@/lib/agent/orchestrator";
import { apiOk, apiRouteError } from "@/lib/api/responses";
import { SceneBrief } from "@/lib/session/types";
import { mockParseScene } from "@/lib/llm/mock";
import { normalizeSceneBriefOptions } from "@/lib/scenarios/normalize";
import { isScenarioId } from "@/lib/scenarios";
import { getRequestIdentity } from "@/lib/auth/request";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) {
    return fallback;
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function asDeepSeekMode(value: unknown): "connected" | "mock" {
  return value === "connected" ? "connected" : "mock";
}

function normalizeSceneBriefInput(value: unknown, fallback: SceneBrief): SceneBrief {
  if (!isRecord(value)) {
    return fallback;
  }

  const budget =
    typeof value.budget === "number" && Number.isFinite(value.budget)
      ? value.budget
      : fallback.budget;

  const priorityStyle =
    value.priority_style === "实用优先" ||
    value.priority_style === "舒适优先" ||
    value.priority_style === "安全优先" ||
    value.priority_style === "性价比优先"
      ? value.priority_style
      : fallback.priority_style;

  return normalizeSceneBriefOptions({
    scenario_id:
      isScenarioId(value.scenario_id)
        ? value.scenario_id
        : fallback.scenario_id,
    scene_type: typeof value.scene_type === "string" && value.scene_type.trim() ? value.scene_type.trim() : fallback.scene_type,
    vehicle_type: typeof value.vehicle_type === "string" && value.vehicle_type.trim() ? value.vehicle_type.trim() : fallback.vehicle_type,
    user_stage: typeof value.user_stage === "string" && value.user_stage.trim() ? value.user_stage.trim() : fallback.user_stage,
    budget,
    priority_style: priorityStyle,
    already_have: asStringArray(value.already_have, fallback.already_have),
    avoid_items: asStringArray(value.avoid_items, fallback.avoid_items),
    optional_notes:
      typeof value.optional_notes === "string" && value.optional_notes.trim()
        ? value.optional_notes.trim()
        : fallback.optional_notes
  }, fallback);
}

export async function POST(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    const body = await request.json().catch(() => ({}));
    const sceneBriefInput = isRecord(body.scene_brief) ? body.scene_brief : undefined;
    const scenarioId = isScenarioId(body.scenario_id)
      ? body.scenario_id
      : isScenarioId(sceneBriefInput?.scenario_id)
        ? sceneBriefInput.scenario_id
        : "new-car";
    const rawInput =
      (typeof body.raw_input === "string" ? body.raw_input : undefined) ??
      (sceneBriefInput
        ? `${sceneBriefInput.vehicle_type ?? ""} ${sceneBriefInput.user_stage ?? ""} 预算 ${sceneBriefInput.budget ?? ""} ${sceneBriefInput.priority_style ?? ""} ${sceneBriefInput.optional_notes ?? ""}`
        : undefined);

    const fallbackScene = mockParseScene(rawInput ?? "", scenarioId);
    const normalizedSceneBrief = sceneBriefInput
      ? normalizeSceneBriefInput(sceneBriefInput, fallbackScene)
      : normalizeSceneBriefInput(undefined, (await parseOnly(rawInput ?? "", scenarioId)).data);
    const parseDeepSeekMode = asDeepSeekMode(body.parse_deepseek_mode);

    const state = sceneBriefInput
      ? await createSessionFromScene(rawInput ?? "", normalizedSceneBrief, parseDeepSeekMode, identity.userId)
      : await initializeSession(rawInput, scenarioId, identity.userId);

    return apiOk({
      session_id: state.session_id,
      scene_brief: state.scene_brief,
      base_template: state.base_template,
      shopping_plan: state.shopping_plan,
      plan_review: state.plan_review,
      module_candidates: state.module_candidates,
      module_reviews: state.module_reviews,
      tool_logs: state.tool_logs,
      execution_mode: state.execution_mode,
      deepseek_status: state.deepseek_status,
      mcp_status: state.mcp_status
    });
  } catch (error) {
    return apiRouteError(error, "planning failed");
  }
}
