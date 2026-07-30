import { NextRequest } from "next/server";
import { ensureSession } from "@/lib/agent/orchestrator";
import { apiOk, apiRouteError, notFound } from "@/lib/api/responses";
import { loadSessions } from "@/lib/session/repository";
import { buildHostedTaskInstruction } from "@/lib/mcp/hosted-protocol";
import { isHostedExecutionTask } from "@/lib/session/guards";
import { getLegacyHostedAccess } from "@/lib/auth/hosted-worker";

export async function GET(request: NextRequest) {
  try {
    const access = await getLegacyHostedAccess(request);
    const sessionId = request.nextUrl.searchParams.get("session_id");

    if (sessionId) {
      const session = await ensureSession(sessionId, access.userId);
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

    const sessions = await loadSessions(access.userId);
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
