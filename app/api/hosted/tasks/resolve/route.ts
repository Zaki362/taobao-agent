import { NextRequest, NextResponse } from "next/server";
import { ensureSession } from "@/lib/agent/orchestrator";
import { resolveHostedAddToCartTask, resolveHostedModuleSearchTask } from "@/lib/mcp/hosted";
import { ProductCandidate } from "@/lib/session/types";
import { saveSession } from "@/lib/session/store";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const session = await ensureSession(body.session_id as string | undefined);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  const task = session.hosted_tasks.find((entry) => entry.task_id === body.task_id);
  if (!task) {
    return NextResponse.json({ error: "task not found" }, { status: 404 });
  }

  if (task.task_type === "module_search") {
    resolveHostedModuleSearchTask(session, {
      task_id: task.task_id,
      status: body.status === "failed" ? "failed" : "completed",
      candidates: (body.candidates ?? []) as ProductCandidate[],
      result_summary: body.result_summary as string | undefined,
      error_message: body.error_message as string | undefined
    });
  } else {
    resolveHostedAddToCartTask(session, {
      task_id: task.task_id,
      status: body.status === "failed" ? "failed" : "completed",
      result_summary: body.result_summary as string | undefined,
      error_message: body.error_message as string | undefined
    });
  }

  saveSession(session);
  return NextResponse.json({
    session_id: session.session_id,
    task,
    hosted_tasks: session.hosted_tasks,
    module_candidates: session.module_candidates,
    selected_items: session.selected_items
  });
}
