import { AuthForm } from "@/components/auth-form";
import { redirectAuthenticatedUser } from "@/lib/auth/page";

export default async function LoginPage() {
  await redirectAuthenticatedUser();
  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-12">
      <AuthForm />
    </main>
  );
}
