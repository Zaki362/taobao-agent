import { apiOk, apiRouteError } from "@/lib/api/responses";
import { getRequestIdentity } from "@/lib/auth/request";
import { inspectRuntimeReadiness } from "@/lib/runtime/readiness";

export async function GET() {
  try {
    const identity = await getRequestIdentity();
    return apiOk(await inspectRuntimeReadiness(identity.userId));
  } catch (error) {
    return apiRouteError(error, "runtime readiness check failed");
  }
}
