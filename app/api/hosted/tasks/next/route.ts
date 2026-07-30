import { NextRequest } from "next/server";
import { ensureSession } from "@/lib/agent/orchestrator";
import { apiOk, apiRouteError, notFound } from "@/lib/api/responses";
import { listSessions } from "@/lib/session/store";
import { buildHostedTaskInstruction } from "@/lib/mcp/hosted-protocol";
import { isHostedExecutionTask } from "@/lib/session/guards";

export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get("session_id");

    if (sessionId) {
      const session = await ensureSession(sessionId);
      if (!session) {
        return notFound("session not found");
      }
      const task = (Array.isArray(session.hosted_tasks) ? session.hosted_tasks : [])
        .filter(isHostedExecutionTask)
        .find((entry) => entry.status === "pending");
      return apiOk({
        task: task ?? null,
        instruction: task ? buildHostedTaskInstruction(task) : null
      });
    }

    const sessions = listSessions();
    const task = sessions
      .flatMap((session) => (Array.isArray(session.hosted_tasks) ? session.hosted_tasks : []).filter(isHostedExecutionTask))
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      .find((entry) => entry.status === "pending");

    return apiOk({
      task: task ?? null,
      instruction: task ? buildHostedTaskInstruction(task) : null
    });
  } catch (error) {
    return apiRouteError(error, "failed to read next hosted task");
  }
}
