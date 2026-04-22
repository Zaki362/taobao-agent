import { NextRequest, NextResponse } from "next/server";
import { parseOnly } from "@/lib/agent/orchestrator";
import { ScenarioId } from "@/lib/session/types";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const rawInput = typeof body.raw_input === "string" ? body.raw_input : "";
    const scenarioId = typeof body.scenario_id === "string" ? (body.scenario_id as ScenarioId) : "new-car";
    const parsed = await parseOnly(rawInput, scenarioId);
    return NextResponse.json({
      scene_brief: parsed.data,
      deepseek_mode: parsed.mode
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "scene parse failed"
      },
      { status: 500 }
    );
  }
}
