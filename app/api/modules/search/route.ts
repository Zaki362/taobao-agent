import { NextRequest, NextResponse } from "next/server";
import { searchModule } from "@/lib/agent/orchestrator";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const result = await searchModule(body.session_id as string, body.module_id as string);
  return NextResponse.json({
    candidates: result.candidates,
    hosted_tasks: result.state.hosted_tasks,
    tool_logs: result.state.tool_logs
  });
}
