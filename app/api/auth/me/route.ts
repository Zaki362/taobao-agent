import { apiOk, apiRouteError } from "@/lib/api/responses";
import { getRequestIdentity, isAuthenticationRequired } from "@/lib/auth/request";
import { runtimeStoreMode } from "@/lib/runtime";

export async function GET() {
  try {
    const identity = await getRequestIdentity();
    return apiOk({
      authenticated: identity.authenticated,
      authentication_required: isAuthenticationRequired(),
      user: identity.authenticated ? { id: identity.userId, email: identity.email } : null,
      runtime_store: runtimeStoreMode()
    });
  } catch (error) {
    return apiRouteError(error, "failed to read authentication state");
  }
}
