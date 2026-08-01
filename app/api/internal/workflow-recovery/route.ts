import { NextRequest } from "next/server";
import { recoverAgentWorkflows } from "@/lib/agent/workflow-recovery";
import { apiOk, apiRouteError } from "@/lib/api/responses";
import { getRuntimeRepository } from "@/lib/runtime";
import { assertWorkflowRecoveryAccess } from "@/lib/runtime/internal-auth";
import { WORKFLOW_RECOVERY_SERVICE } from "@/lib/runtime/recovery-heartbeat";

export const runtime = "nodejs";
export const maxDuration = 60;

async function recover(request: NextRequest) {
  try {
    assertWorkflowRecoveryAccess(request);
    const limitValue = Number(request.nextUrl.searchParams.get("limit") ?? 5);
    const limit = Math.min(Math.max(Number.isFinite(limitValue) ? limitValue : 5, 1), 5);
    try {
      const result = await recoverAgentWorkflows({
        limit,
        maxRecoveries: limit
      });
      const failed = result.items.filter((item) => item.reason === "recovery_failed").length;
      const checkedAt = new Date().toISOString();
      await getRuntimeRepository().recordServiceHeartbeat({
        service_name: WORKFLOW_RECOVERY_SERVICE,
        status: failed > 0 ? "degraded" : "healthy",
        metadata: {
          scanned: result.scanned,
          recovered: result.recovered,
          failed
        },
        checked_at: checkedAt
      });
      return apiOk({
        ...result,
        failed,
        checked_at: checkedAt
      });
    } catch (error) {
      const checkedAt = new Date().toISOString();
      await getRuntimeRepository().recordServiceHeartbeat({
        service_name: WORKFLOW_RECOVERY_SERVICE,
        status: "failed",
        metadata: { scanned: 0, recovered: 0, failed: 1 },
        checked_at: checkedAt
      }).catch(() => undefined);
      throw error;
    }
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
