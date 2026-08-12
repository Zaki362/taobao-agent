import { NextRequest } from "next/server";
import { addToCart } from "@/lib/agent/orchestrator";
import { apiOk, apiRouteError, conflict, requireString } from "@/lib/api/responses";
import { getRequestIdentity } from "@/lib/auth/request";

export async function POST(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    const body = await request.json().catch(() => ({}));
    const sessionId = requireString(body.session_id, "session_id");
    const productId = requireString(body.product_id, "product_id");
    if (body.confirmed !== true) {
      return conflict("加入购物车需要用户显式确认。");
    }
    const result = await addToCart(sessionId, productId, identity.userId);
    const payload = result.result as { success?: boolean; message?: string; task_id?: string; demo_fallback?: boolean } | undefined;
    return apiOk({
      result: result.result,
      async: Boolean(payload?.task_id),
      demo_fallback: Boolean(payload?.demo_fallback),
      hosted_tasks: result.state.hosted_tasks,
      selected_items: result.state.selected_items,
      tool_logs: result.state.tool_logs
    });
  } catch (error) {
    return apiRouteError(error, "add to cart failed");
  }
}
