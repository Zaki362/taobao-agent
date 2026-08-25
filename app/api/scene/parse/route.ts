import { NextRequest } from "next/server";
import { parseOnly } from "@/lib/agent/orchestrator";
import { apiOk, apiRouteError } from "@/lib/api/responses";
import { isScenarioId } from "@/lib/scenarios";
import { getRequestIdentity } from "@/lib/auth/request";
import { enforceAiRateLimit, withAiConcurrencyLimit } from "@/lib/security/rate-limit";
import { API_INPUT_LIMITS, boundedString, readJsonObject } from "@/lib/api/validation";

export async function POST(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    await enforceAiRateLimit(request, identity.userId);
    const body = await readJsonObject(request);
    const rawInput = boundedString(body.raw_input, "raw_input", {
      maxLength: API_INPUT_LIMITS.sceneInputLength,
      required: true
    });
    const scenarioId = isScenarioId(body.scenario_id) ? body.scenario_id : "new-car";
    const parsed = await withAiConcurrencyLimit(request, identity.userId, () => parseOnly(rawInput, scenarioId));
    return apiOk({
      scene_brief: parsed.data,
      deepseek_mode: parsed.mode,
      llm_call: parsed.call
    });
  } catch (error) {
    return apiRouteError(error, "scene parse failed");
  }
}
