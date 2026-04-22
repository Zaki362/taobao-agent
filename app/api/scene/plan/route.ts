import { NextRequest, NextResponse } from "next/server";
import { createSessionFromScene, initializeSession, parseOnly } from "@/lib/agent/orchestrator";
import { ScenarioId, SceneBrief } from "@/lib/session/types";
import { mockParseScene } from "@/lib/llm/mock";

function normalizeSceneBriefInput(value: SceneBrief | undefined, fallback: SceneBrief): SceneBrief {
  if (!value) {
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

  return {
    scenario_id:
      value.scenario_id === "new-car" ||
      value.scenario_id === "camping" ||
      value.scenario_id === "room-decor" ||
      value.scenario_id === "dorm-move-in" ||
      value.scenario_id === "moving-setup"
        ? value.scenario_id
        : fallback.scenario_id,
    scene_type: typeof value.scene_type === "string" && value.scene_type ? value.scene_type : fallback.scene_type,
    vehicle_type: typeof value.vehicle_type === "string" && value.vehicle_type ? value.vehicle_type : fallback.vehicle_type,
    user_stage: typeof value.user_stage === "string" && value.user_stage ? value.user_stage : fallback.user_stage,
    budget,
    priority_style: priorityStyle,
    already_have: Array.isArray(value.already_have) ? value.already_have.filter((item): item is string => typeof item === "string") : fallback.already_have,
    avoid_items: Array.isArray(value.avoid_items) ? value.avoid_items.filter((item): item is string => typeof item === "string") : fallback.avoid_items,
    optional_notes:
      typeof value.optional_notes === "string" && value.optional_notes
        ? value.optional_notes
        : fallback.optional_notes
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const sceneBrief = body.scene_brief as SceneBrief | undefined;
    const scenarioId = typeof body.scenario_id === "string" ? (body.scenario_id as ScenarioId) : sceneBrief?.scenario_id ?? "new-car";
    const rawInput =
      (body.raw_input as string | undefined) ??
      (body.scene_brief
        ? `${body.scene_brief.vehicle_type ?? ""} ${body.scene_brief.user_stage ?? ""} 预算 ${body.scene_brief.budget ?? ""} ${body.scene_brief.priority_style ?? ""} ${body.scene_brief.optional_notes ?? ""}`
        : undefined);

    const fallbackScene = sceneBrief ?? mockParseScene(rawInput ?? "", scenarioId);
    const normalizedSceneBrief = sceneBrief
      ? normalizeSceneBriefInput(sceneBrief, fallbackScene)
      : normalizeSceneBriefInput(undefined, (await parseOnly(rawInput ?? "", scenarioId)).data);

    const state = sceneBrief
      ? await createSessionFromScene(rawInput ?? "", normalizedSceneBrief, body.deepseek_mode === "connected" ? "connected" : "mock")
      : await initializeSession(rawInput, scenarioId);

    return NextResponse.json({
      session_id: state.session_id,
      scene_brief: state.scene_brief,
      base_template: state.base_template,
      shopping_plan: state.shopping_plan,
      module_candidates: state.module_candidates,
      tool_logs: state.tool_logs,
      execution_mode: state.execution_mode,
      deepseek_status: state.deepseek_status,
      mcp_status: state.mcp_status
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "planning failed"
      },
      { status: 500 }
    );
  }
}
