import { NextRequest } from "next/server";
import { adoptPurchaseBundle } from "@/lib/agent/orchestrator";
import { PurchaseBundleAdoptionError } from "@/lib/session/bundle-adoption";
import { ApiRouteError, apiOk, apiRouteError, requireString } from "@/lib/api/responses";
import { getRequestIdentity } from "@/lib/auth/request";

export async function POST(request: NextRequest) {
  try {
    const identity = await getRequestIdentity();
    const body = await request.json().catch(() => ({}));
    if (body.confirmed !== true) {
      throw new ApiRouteError("必须由用户显式确认采用 Agent 购买组合。", 400, "confirmation_required");
    }

    const result = await adoptPurchaseBundle(
      requireString(body.session_id, "session_id"),
      requireString(body.bundle_generated_at, "bundle_generated_at"),
      identity.userId
    );
    return apiOk({
      session_id: result.state.session_id,
      state: result.state,
      bundle_adoption: result.adoption
    });
  } catch (error) {
    if (error instanceof PurchaseBundleAdoptionError) {
      return apiRouteError(
        new ApiRouteError(error.message, 409, error.code),
        "purchase bundle adoption failed"
      );
    }
    return apiRouteError(error, "purchase bundle adoption failed");
  }
}
