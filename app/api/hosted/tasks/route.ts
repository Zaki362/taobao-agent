import { NextRequest, NextResponse } from "next/server";
import { ensureSession } from "@/lib/agent/orchestrator";
import { buildHostedTaskInstruction } from "@/lib/mcp/hosted-protocol";
import { listSessions, saveSession } from "@/lib/session/store";

function hasTaskId(value: unknown): value is { task_id: string; updated_at: string } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.task_id === "string" && typeof record.updated_at === "string";
}

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session_id");
  const taskId = request.nextUrl.searchParams.get("task_id");

  if (sessionId) {
    const session = await ensureSession(sessionId);
    if (!session) {
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }

    if (taskId) {
      const task = session.hosted_tasks.filter(hasTaskId).find((entry) => entry.task_id === taskId);
      if (!task) {
        return NextResponse.json({ error: "task not found" }, { status: 404 });
      }

      return NextResponse.json({
        task,
        instruction: buildHostedTaskInstruction(task)
      });
    }

    return NextResponse.json({
      tasks: (Array.isArray(session.hosted_tasks) ? session.hosted_tasks : []).filter(hasTaskId)
    });
  }

  const tasks = listSessions()
    .flatMap((session) => (Array.isArray(session.hosted_tasks) ? session.hosted_tasks : []).filter(hasTaskId))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));

  return NextResponse.json({ tasks });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const session = await ensureSession(body.session_id as string | undefined);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  const task = (Array.isArray(session.hosted_tasks) ? session.hosted_tasks : [])
    .filter(hasTaskId)
    .find((entry) => entry.task_id === body.task_id);
  if (!task) {
    return NextResponse.json({ error: "task not found" }, { status: 404 });
  }

  task.status = body.status === "running" ? "running" : task.status;
  task.updated_at = new Date().toISOString();
  saveSession(session);

  return NextResponse.json({ task });
}
