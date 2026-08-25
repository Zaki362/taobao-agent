import { NextRequest } from "next/server";
import { getRequestIdentity } from "@/lib/auth/request";
import { apiOk, apiRouteError, requireString } from "@/lib/api/responses";
import { getRuntimeRepository } from "@/lib/runtime";
import { ensureSession } from "@/lib/agent/orchestrator";
import { publicRuntimeJob } from "@/lib/runtime/public-dto";

export async function GET(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    const sessionId = requireString(request.nextUrl.searchParams.get("session_id"), "session_id");
    const session = await ensureSession(sessionId, identity.userId);
    if (!session) return apiOk({ jobs: [] });
    const jobs = await getRuntimeRepository().listJobs(sessionId, identity.userId);
    return apiOk({ jobs: jobs.map(publicRuntimeJob) });
  } catch (error) {
    return apiRouteError(error, "failed to list runtime jobs");
  }
}
