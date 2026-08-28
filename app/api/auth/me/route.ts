import { apiOk, apiRouteError } from "@/lib/api/responses";
import { getRequestIdentity, isAuthenticationRequired } from "@/lib/auth/request";
import { runtimeStoreMode } from "@/lib/runtime";

export async function GET() {
  try {
    const identity = await getRequestIdentity();
    if (identity.accessMode === "single_user") {
      return apiOk({
        authenticated: true,
        access_mode: "single_user" as const,
        persistence_scope: "single_user" as const
      });
    }
    return apiOk({
      authenticated: identity.authenticated,
      authentication_required: isAuthenticationRequired(),
      access_mode: identity.accessMode,
      persistence_scope: identity.authenticated ? "account" as const : "anonymous" as const,
      user: identity.authenticated ? { id: identity.userId, email: identity.email } : null,
      runtime_store: runtimeStoreMode()
    });
  } catch (error) {
    return apiRouteError(error, "failed to read authentication state");
  }
}
