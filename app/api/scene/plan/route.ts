import { NextRequest } from "next/server";
import { createSessionFromScene, initializeSession } from "@/lib/agent/orchestrator";
import { apiOk, apiRouteError } from "@/lib/api/responses";
import { SceneBrief } from "@/lib/session/types";
import { mockParseScene } from "@/lib/llm/mock";
import { normalizeSceneBriefOptions } from "@/lib/scenarios/normalize";
import { isScenarioId } from "@/lib/scenarios";
import { getRequestIdentity } from "@/lib/auth/request";
import { enforceAiRateLimit, withAiConcurrencyLimit } from "@/lib/security/rate-limit";
import {
  API_INPUT_LIMITS,
  boundedNumber,
  boundedString,
  boundedStringArray,
  readJsonObject
} from "@/lib/api/validation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown, fallback: string[], fieldName: string) {
  return boundedStringArray(value, fieldName, {
    maxItems: API_INPUT_LIMITS.sceneListItems,
    maxItemLength: API_INPUT_LIMITS.sceneListItemLength,
    fallback
  });
}

function asDeepSeekMode(value: unknown): "connected" | "mock" {
  return value === "connected" ? "connected" : "mock";
}

function normalizeSceneBriefInput(value: unknown, fallback: SceneBrief): SceneBrief {
  if (!isRecord(value)) {
    return fallback;
  }

  const budget = boundedNumber(value.budget, "scene_brief.budget", {
    min: API_INPUT_LIMITS.budgetMin,
    max: API_INPUT_LIMITS.budgetMax,
    fallback: fallback.budget
  });

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
    scene_type: boundedString(value.scene_type, "scene_brief.scene_type", {
      maxLength: API_INPUT_LIMITS.sceneLabelLength,
      fallback: fallback.scene_type
    }),
    vehicle_type: boundedString(value.vehicle_type, "scene_brief.vehicle_type", {
      maxLength: API_INPUT_LIMITS.sceneLabelLength,
      fallback: fallback.vehicle_type
    }),
    user_stage: boundedString(value.user_stage, "scene_brief.user_stage", {
      maxLength: API_INPUT_LIMITS.sceneLabelLength,
      fallback: fallback.user_stage
    }),
    budget,
    priority_style: priorityStyle,
    already_have: asStringArray(value.already_have, fallback.already_have, "scene_brief.already_have"),
    avoid_items: asStringArray(value.avoid_items, fallback.avoid_items, "scene_brief.avoid_items"),
    optional_notes: boundedString(value.optional_notes, "scene_brief.optional_notes", {
      maxLength: API_INPUT_LIMITS.optionalNotesLength,
      fallback: fallback.optional_notes
    })
  }, fallback);
}

export async function POST(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    await enforceAiRateLimit(request, identity.userId);
    const body = await readJsonObject(request);
    const sceneBriefInput = isRecord(body.scene_brief) ? body.scene_brief : undefined;
    const scenarioId = isScenarioId(body.scenario_id)
      ? body.scenario_id
      : isScenarioId(sceneBriefInput?.scenario_id)
        ? sceneBriefInput.scenario_id
        : "new-car";
    const providedRawInput = boundedString(body.raw_input, "raw_input", {
      maxLength: API_INPUT_LIMITS.sceneInputLength,
      required: !sceneBriefInput
    });

    const parseDeepSeekMode = asDeepSeekMode(body.parse_deepseek_mode);

    const normalizedSceneBrief = sceneBriefInput
      ? normalizeSceneBriefInput(sceneBriefInput, mockParseScene(providedRawInput, scenarioId))
      : undefined;
    const rawInput = providedRawInput || (normalizedSceneBrief
      ? `${normalizedSceneBrief.vehicle_type} ${normalizedSceneBrief.user_stage} 预算 ${normalizedSceneBrief.budget} ${normalizedSceneBrief.priority_style} ${normalizedSceneBrief.optional_notes}`.trim()
      : "");

    const state = await withAiConcurrencyLimit(request, identity.userId, () => normalizedSceneBrief
      ? createSessionFromScene(
          rawInput ?? "",
          normalizedSceneBrief,
          parseDeepSeekMode,
          identity.userId
        )
      : initializeSession(rawInput, scenarioId, identity.userId));

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
