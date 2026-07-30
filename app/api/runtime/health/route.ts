import { apiOk, apiRouteError } from "@/lib/api/responses";
import { query } from "@/lib/runtime/database";
import { runtimeStoreMode } from "@/lib/runtime";

export async function GET() {
  try {
    const store = runtimeStoreMode();
    if (store === "postgres") await query("SELECT 1");
    return apiOk({
      status: "healthy",
      runtime_store: store,
      executor_backend: process.env.TAOBAO_EXECUTION_BACKEND ?? "auto",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return apiRouteError(error, "runtime health check failed");
  }
}
