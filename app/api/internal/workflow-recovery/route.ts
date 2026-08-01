import { NextRequest } from "next/server";
import { recoverAgentWorkflows } from "@/lib/agent/workflow-recovery";
import { apiOk, apiRouteError } from "@/lib/api/responses";
import { assertWorkflowRecoveryAccess } from "@/lib/runtime/internal-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

async function recover(request: NextRequest) {
  try {
    assertWorkflowRecoveryAccess(request);
    const limitValue = Number(request.nextUrl.searchParams.get("limit") ?? 5);
    const limit = Math.min(Math.max(Number.isFinite(limitValue) ? limitValue : 5, 1), 5);
    const result = await recoverAgentWorkflows({
      limit,
      maxRecoveries: limit
    });
    return apiOk({
      ...result,
      checked_at: new Date().toISOString()
    });
  } catch (error) {
    return apiRouteError(error, "workflow recovery failed");
  }
}

export async function GET(request: NextRequest) {
  return recover(request);
}

export async function POST(request: NextRequest) {
  return recover(request);
}
