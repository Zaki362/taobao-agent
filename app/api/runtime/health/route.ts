import { apiOk, apiRouteError } from "@/lib/api/responses";
import { query } from "@/lib/runtime/database";
import { runtimeStoreMode } from "@/lib/runtime";
import { allowDemoCartFallback, getProductMode } from "@/lib/runtime/product-mode";
import { getConfiguredExecutionBackend, getExecutionBackend } from "@/lib/mcp/client";

export async function GET() {
  try {
    const store = runtimeStoreMode();
    if (store === "postgres") await query("SELECT 1");
    return apiOk({
      status: "healthy",
      product_mode: getProductMode(),
      demo_cart_fallback: allowDemoCartFallback(),
      runtime_store: store,
      configured_executor_backend: getConfiguredExecutionBackend(),
      effective_executor_backend: getExecutionBackend(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return apiRouteError(error, "runtime health check failed");
  }
}
