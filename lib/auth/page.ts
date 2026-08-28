import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ApiRouteError } from "@/lib/api/responses";
import { isSingleUserAccessMode } from "@/lib/auth/access-mode";
import { getRequestIdentity, isAuthenticationRequired } from "@/lib/auth/request";
import { normalizeAuthReturnPath } from "@/lib/auth/return-path";
import type { Route } from "next";

export async function requirePageIdentity() {
  await connection();
  if (isSingleUserAccessMode()) return getRequestIdentity();
  if (!isAuthenticationRequired()) return null;
  const identity = await getRequestIdentity().catch(() => null);
  if (!identity?.authenticated) {
    throw new ApiRouteError(
      "固定单用户访问尚未正确配置",
      503,
      "single_user_access_required"
    );
  }
  return identity;
}

export async function requireAuthenticatedPageIdentity(_returnTo: Route = "/") {
  await connection();
  const identity = isSingleUserAccessMode()
    ? await getRequestIdentity()
    : await getRequestIdentity().catch(() => null);
  if (!identity?.authenticated) {
    throw new ApiRouteError(
      "固定单用户访问尚未正确配置",
      503,
      "single_user_access_required"
    );
  }
  return identity;
}

export async function redirectAuthenticatedUser(returnTo: Route = "/") {
  await connection();
  const identity = isSingleUserAccessMode()
    ? await getRequestIdentity()
    : await getRequestIdentity().catch(() => null);
  if (identity?.authenticated) redirect(normalizeAuthReturnPath(returnTo));
}
