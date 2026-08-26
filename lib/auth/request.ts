import { cookies } from "next/headers";
import { ApiRouteError } from "@/lib/api/responses";
import { AUTH_COOKIE_NAME } from "@/lib/auth/constants";
import {
  configuredSingleUserId,
  getSceneCartAccessMode,
  resolveSingleUserOwner
} from "@/lib/auth/access-mode";
import { authenticateToken } from "@/lib/auth/service";
import { isFormalProductMode } from "@/lib/runtime/product-mode";

export { AUTH_COOKIE_NAME } from "@/lib/auth/constants";

function hasHttpsAppOrigin() {
  const origins = (process.env.APP_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length > 0 && origins.every((origin) => /^https:\/\//i.test(origin));
}

export function shouldUseSecureAuthCookie() {
  // An explicit false must never downgrade cookies on a configured HTTPS deployment.
  if (hasHttpsAppOrigin()) return true;
  if (process.env.AUTH_COOKIE_SECURE === "true") return true;
  if (process.env.AUTH_COOKIE_SECURE === "false") return false;
  return process.env.NODE_ENV === "production";
}

export function isAuthenticationRequired() {
  // Preview-only single-user mode keeps a stable owner without an interactive login.
  if (getSceneCartAccessMode() === "single_user") {
    configuredSingleUserId();
    return false;
  }
  // Multi-user formal sessions and executor devices must always be isolated by account.
  return isFormalProductMode() || process.env.AUTH_REQUIRED === "true";
}

export async function getRequestIdentity() {
  const accessMode = getSceneCartAccessMode();
  if (accessMode === "single_user") {
    const user = await resolveSingleUserOwner();
    if (!user) {
      throw new ApiRouteError("单用户 owner 未配置", 503, "single_user_owner_misconfigured");
    }
    return {
      userId: user.id,
      email: user.email,
      authenticated: true as const,
      accessMode: "single_user" as const
    };
  }
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  const authenticated = token ? await authenticateToken(token) : null;
  if (authenticated) {
    return {
      userId: authenticated.user.id,
      email: authenticated.user.email,
      authenticated: true as const,
      accessMode: "account" as const
    };
  }
  if (isAuthenticationRequired()) {
    throw new ApiRouteError("请先登录后继续", 401, "authentication_required");
  }
  return {
    userId: undefined,
    email: undefined,
    authenticated: false as const,
    accessMode: "anonymous" as const
  };
}

export async function requireAuthenticatedIdentity() {
  const identity = await getRequestIdentity();
  if (!identity.authenticated || !identity.userId) {
    throw new ApiRouteError("该操作需要登录账号", 401, "authentication_required");
  }
  return identity;
}
