import { NextResponse } from "next/server";
import { listSessions } from "@/lib/session/store";

export async function GET() {
  const sessions = listSessions()
    .sort((a, b) => Number(b.session_id.split("-").pop() ?? 0) - Number(a.session_id.split("-").pop() ?? 0))
    .map((session) => ({
      session_id: session.session_id,
      raw_input: session.raw_input,
      current_scene_label: session.current_scene_label,
      execution_mode: session.execution_mode,
      deepseek_status: session.deepseek_status,
      mcp_status: session.mcp_status,
      scene_brief: session.scene_brief,
      shopping_plan: session.shopping_plan,
      selected_items: session.selected_items,
      module_candidates: session.module_candidates,
      tool_logs: session.tool_logs,
      hosted_tasks: session.hosted_tasks
    }));

  return NextResponse.json({ sessions });
}
