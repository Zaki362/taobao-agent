import { NextRequest } from "next/server";
import { ensureSession } from "@/lib/agent/orchestrator";
import { apiOk, apiRouteError, notFound } from "@/lib/api/responses";

export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get("session_id") ?? undefined;
    const state = await ensureSession(sessionId);
    if (!state) {
      return notFound("session not found");
    }
    return apiOk(state);
  } catch (error) {
    return apiRouteError(error, "failed to read session state");
  }
}
