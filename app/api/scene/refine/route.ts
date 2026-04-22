import { NextRequest, NextResponse } from "next/server";
import { refineSession } from "@/lib/agent/orchestrator";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const result = await refineSession(body.session_id as string, body.quick_action);
  return NextResponse.json({
    session_id: result.state.session_id,
    scene_brief: result.state.scene_brief,
    shopping_plan: result.state.shopping_plan,
    module_candidates: result.state.module_candidates,
    hosted_tasks: result.state.hosted_tasks,
    tool_logs: result.state.tool_logs,
    impacted_modules: result.impactedModules
  });
}
