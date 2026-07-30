import { NextRequest } from "next/server";
import { ensureSession } from "@/lib/agent/orchestrator";
import { apiOk, apiRouteError, notFound, requireString } from "@/lib/api/responses";
import { buildHostedTaskInstruction } from "@/lib/mcp/hosted-protocol";
import { listSessions, saveSession } from "@/lib/session/store";
import { isHostedExecutionTask } from "@/lib/session/guards";

export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get("session_id");
    const taskId = request.nextUrl.searchParams.get("task_id");

    if (sessionId) {
      const session = await ensureSession(sessionId);
      if (!session) {
        return notFound("session not found");
      }

      if (taskId) {
        const task = session.hosted_tasks.filter(isHostedExecutionTask).find((entry) => entry.task_id === taskId);
        if (!task) {
          return notFound("task not found");
        }

        return apiOk({
          task,
          instruction: buildHostedTaskInstruction(task)
        });
      }

      return apiOk({
        tasks: (Array.isArray(session.hosted_tasks) ? session.hosted_tasks : []).filter(isHostedExecutionTask)
      });
    }

    const tasks = listSessions()
      .flatMap((session) => (Array.isArray(session.hosted_tasks) ? session.hosted_tasks : []).filter(isHostedExecutionTask))
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));

    return apiOk({ tasks });
  } catch (error) {
    return apiRouteError(error, "failed to list hosted tasks");
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const sessionId = requireString(body.session_id, "session_id");
    const taskId = requireString(body.task_id, "task_id");
    const session = await ensureSession(sessionId);
    if (!session) {
      return notFound("session not found");
    }

    const task = (Array.isArray(session.hosted_tasks) ? session.hosted_tasks : [])
      .filter(isHostedExecutionTask)
      .find((entry) => entry.task_id === taskId);
    if (!task) {
      return notFound("task not found");
    }

    task.status = body.status === "running" ? "running" : task.status;
    task.updated_at = new Date().toISOString();
    saveSession(session);

    return apiOk({ task });
  } catch (error) {
    return apiRouteError(error, "failed to update hosted task");
  }
}
