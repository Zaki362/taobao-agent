import { NextRequest, NextResponse } from "next/server";
import { ensureSession } from "@/lib/agent/orchestrator";
import { listSessions } from "@/lib/session/store";
import { buildHostedTaskInstruction } from "@/lib/mcp/hosted-protocol";

function isPendingTask(value: unknown): value is { status: string; updated_at: string } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.status === "string" && typeof record.updated_at === "string";
}

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session_id");

  if (sessionId) {
    const session = await ensureSession(sessionId);
    if (!session) {
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }
    const task = (Array.isArray(session.hosted_tasks) ? session.hosted_tasks : [])
      .filter(isPendingTask)
      .find((entry) => entry.status === "pending");
    return NextResponse.json({
      task: task ?? null,
      instruction: task ? buildHostedTaskInstruction(task) : null
    });
  }

  const sessions = listSessions();
  const task = sessions
    .flatMap((session) => (Array.isArray(session.hosted_tasks) ? session.hosted_tasks : []).filter(isPendingTask))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .find((entry) => entry.status === "pending");

  return NextResponse.json({
    task: task ?? null,
    instruction: task ? buildHostedTaskInstruction(task) : null
  });
}
