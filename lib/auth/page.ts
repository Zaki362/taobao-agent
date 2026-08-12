import { redirect } from "next/navigation";
import { getRequestIdentity, isAuthenticationRequired } from "@/lib/auth/request";
import { normalizeAuthReturnPath } from "@/lib/auth/return-path";

export async function requirePageIdentity() {
  if (!isAuthenticationRequired()) return null;
  const identity = await getRequestIdentity().catch(() => null);
  if (!identity?.authenticated) redirect("/login");
  return identity;
}

export async function requireAuthenticatedPageIdentity(returnTo = "/") {
  const identity = await getRequestIdentity().catch(() => null);
  if (!identity?.authenticated) {
    const safeReturnTo = normalizeAuthReturnPath(returnTo);
    redirect(`/login?next=${encodeURIComponent(safeReturnTo)}`);
  }
  return identity;
}

export async function redirectAuthenticatedUser(returnTo = "/") {
  const identity = await getRequestIdentity().catch(() => null);
  if (identity?.authenticated) redirect(normalizeAuthReturnPath(returnTo));
}
