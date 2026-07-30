import { cookies } from "next/headers";
import { ApiRouteError } from "@/lib/api/responses";
import { authenticateToken } from "@/lib/auth/service";

export const AUTH_COOKIE_NAME = "scenecart_session";

export function useSecureAuthCookie() {
  if (process.env.AUTH_COOKIE_SECURE === "true") return true;
  if (process.env.AUTH_COOKIE_SECURE === "false") return false;
  return process.env.NODE_ENV === "production";
}

export function isAuthenticationRequired() {
  return process.env.AUTH_REQUIRED === "true";
}

export async function getRequestIdentity() {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  const authenticated = token ? await authenticateToken(token) : null;
  if (authenticated) {
    return {
      userId: authenticated.user.id,
      email: authenticated.user.email,
      authenticated: true as const
    };
  }
  if (isAuthenticationRequired()) {
    throw new ApiRouteError("请先登录后继续", 401, "authentication_required");
  }
  return {
    userId: undefined,
    email: undefined,
    authenticated: false as const
  };
}

export async function requireAuthenticatedIdentity() {
  const identity = await getRequestIdentity();
  if (!identity.authenticated || !identity.userId) {
    throw new ApiRouteError("该操作需要登录账号", 401, "authentication_required");
  }
  return identity;
}
