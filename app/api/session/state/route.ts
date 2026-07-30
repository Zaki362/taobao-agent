import { NextRequest } from "next/server";
import { ensureSession } from "@/lib/agent/orchestrator";
import { apiOk, apiRouteError, notFound } from "@/lib/api/responses";
import { getRequestIdentity } from "@/lib/auth/request";

export async function GET(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    const sessionId = request.nextUrl.searchParams.get("session_id") ?? undefined;
    const state = await ensureSession(sessionId, identity.userId);
    if (!state) {
      return notFound("session not found");
    }
    return apiOk(state);
  } catch (error) {
    return apiRouteError(error, "failed to read session state");
  }
}
