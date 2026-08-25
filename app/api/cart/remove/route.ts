import { NextRequest } from "next/server";
import { removeDemoCartItem } from "@/lib/agent/orchestrator";
import { CartItemRemovalError } from "@/lib/agent/cart";
import { ApiRouteError, apiOk, apiRouteError, requireString } from "@/lib/api/responses";
import { getRequestIdentity } from "@/lib/auth/request";
import { enforceWorkflowMutationRateLimit } from "@/lib/security/rate-limit";
import { readJsonObject } from "@/lib/api/validation";

export async function POST(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    await enforceWorkflowMutationRateLimit(request, identity.userId);
    const body = await readJsonObject(request);
    if (body.confirmed !== true) {
      throw new ApiRouteError("移除产品内演示商品需要用户显式确认。", 400, "confirmation_required");
    }

    const result = await removeDemoCartItem(
      requireString(body.session_id, "session_id"),
      requireString(body.product_id, "product_id"),
      identity.userId
    );

    return apiOk({
      session_id: result.state.session_id,
      state: result.state,
      removed_item: result.removedItem,
      selected_items: result.state.selected_items,
      bundle_adoption: result.state.bundle_adoption
    });
  } catch (error) {
    if (error instanceof CartItemRemovalError) {
      const status = error.code === "cart_item_not_found" ? 404 : 409;
      return apiRouteError(new ApiRouteError(error.message, status, error.code), "remove cart item failed");
    }
    return apiRouteError(error, "remove cart item failed");
  }
}
