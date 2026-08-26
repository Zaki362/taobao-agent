import { AuthForm } from "@/components/auth-form";
import { normalizeAuthReturnPath } from "@/lib/auth/return-path";
import { redirectAuthenticatedUser } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  const returnTo = normalizeAuthReturnPath(params.next);
  await redirectAuthenticatedUser(returnTo);
  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-12">
      <AuthForm returnTo={returnTo} />
    </main>
  );
}
