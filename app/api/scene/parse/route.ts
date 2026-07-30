import { NextRequest } from "next/server";
import { parseOnly } from "@/lib/agent/orchestrator";
import { apiOk, apiRouteError, requireString } from "@/lib/api/responses";
import { isScenarioId } from "@/lib/scenarios";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const rawInput = requireString(body.raw_input, "raw_input");
    const scenarioId = isScenarioId(body.scenario_id) ? body.scenario_id : "new-car";
    const parsed = await parseOnly(rawInput, scenarioId);
    return apiOk({
      scene_brief: parsed.data,
      deepseek_mode: parsed.mode
    });
  } catch (error) {
    return apiRouteError(error, "scene parse failed");
  }
}
