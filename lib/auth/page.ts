import { redirect } from "next/navigation";
import { getRequestIdentity, isAuthenticationRequired } from "@/lib/auth/request";

export async function requirePageIdentity() {
  if (!isAuthenticationRequired()) return null;
  const identity = await getRequestIdentity().catch(() => null);
  if (!identity?.authenticated) redirect("/login");
  return identity;
}

export async function redirectAuthenticatedUser() {
  if (!isAuthenticationRequired()) return;
  const identity = await getRequestIdentity().catch(() => null);
  if (identity?.authenticated) redirect("/");
}
