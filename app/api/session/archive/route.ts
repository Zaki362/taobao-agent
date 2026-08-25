import { NextRequest } from "next/server";
import { ApiRouteError, apiOk, apiRouteError, requireString } from "@/lib/api/responses";
import { getRequestIdentity } from "@/lib/auth/request";
import { ShoppingSessionLifecycleError, updateShoppingSessionLifecycle } from "@/lib/session/lifecycle";
import { enforceWorkflowMutationRateLimit } from "@/lib/security/rate-limit";
import { readJsonObject } from "@/lib/api/validation";

export async function POST(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    await enforceWorkflowMutationRateLimit(request, identity.userId);
    const body = await readJsonObject(request);
    if (body.confirmed !== true) {
      throw new ApiRouteError("归档或恢复购物任务需要用户显式确认。", 400, "confirmation_required");
    }
    const action = body.action === "archive" || body.action === "restore" ? body.action : null;
    if (!action) {
      throw new ApiRouteError("action 必须是 archive 或 restore。", 400, "invalid_lifecycle_action");
    }

    const result = await updateShoppingSessionLifecycle(
      requireString(body.session_id, "session_id"),
      action,
      identity.userId
    );
    return apiOk(result);
  } catch (error) {
    if (error instanceof ShoppingSessionLifecycleError) {
      return apiRouteError(new ApiRouteError(error.message, 404, error.code), "shopping session lifecycle update failed");
    }
    return apiRouteError(error, "shopping session lifecycle update failed");
  }
}
