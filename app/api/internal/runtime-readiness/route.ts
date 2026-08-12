import { apiOk, apiRouteError } from "@/lib/api/responses";
import { assertInternalOperationsAccess } from "@/lib/runtime/internal-auth";
import { inspectRuntimeReadiness } from "@/lib/runtime/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    assertInternalOperationsAccess(request);
    const response = apiOk(await inspectRuntimeReadiness());
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  } catch (error) {
    return apiRouteError(error, "internal runtime readiness check failed");
  }
}
