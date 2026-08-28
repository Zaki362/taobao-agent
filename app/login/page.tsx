import { AuthForm } from "@/components/auth-form";
import { PublicDemoLink } from "@/components/public-demo-link";
import { normalizeAuthReturnPath } from "@/lib/auth/return-path";
import { redirectAuthenticatedUser } from "@/lib/auth/page";
import { ShoppingBag } from "lucide-react";
import Link from "next/link";

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
    <div className="landing-shell">
      <header className="landing-nav">
        <Link href="/" className="flex min-w-0 items-center gap-3" aria-label="SceneCart 首页">
          <span className="brand-mark" aria-hidden="true">
            <ShoppingBag className="h-4 w-4" strokeWidth={2.2} />
          </span>
          <span>
            <span className="block text-[15px] font-semibold leading-none tracking-tight">SceneCart</span>
            <span className="mt-1 hidden text-[11px] text-muted-foreground sm:block">场景化购物助手</span>
          </span>
        </Link>
        <nav aria-label="登录页导航">
          <PublicDemoLink descriptive />
        </nav>
      </header>
      <main className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-1 py-10 sm:px-5 sm:py-12">
        <AuthForm returnTo={returnTo} />
      </main>
    </div>
  );
}
