import { redirect } from "next/navigation";
import { connection } from "next/server";
import { isSingleUserAccessMode } from "@/lib/auth/access-mode";
import { getRequestIdentity, isAuthenticationRequired } from "@/lib/auth/request";
import { normalizeAuthReturnPath } from "@/lib/auth/return-path";
import type { Route } from "next";

export async function requirePageIdentity() {
  await connection();
  if (isSingleUserAccessMode()) return getRequestIdentity();
  if (!isAuthenticationRequired()) return null;
  const identity = await getRequestIdentity().catch(() => null);
  if (!identity?.authenticated) redirect("/login");
  return identity;
}

export async function requireAuthenticatedPageIdentity(returnTo: Route = "/") {
  await connection();
  const identity = isSingleUserAccessMode()
    ? await getRequestIdentity()
    : await getRequestIdentity().catch(() => null);
  if (!identity?.authenticated) {
    const safeReturnTo = normalizeAuthReturnPath(returnTo);
    redirect(`/login?next=${encodeURIComponent(safeReturnTo)}`);
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
