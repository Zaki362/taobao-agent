import { Suspense } from "react";
import { ErrorBoundary } from "@/components/error-boundary";
import { Dashboard } from "@/components/dashboard";
import { requirePageIdentity } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  await requirePageIdentity();
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <main className="min-h-screen">
            <div className="page-shell">
              <div className="section-card px-6 py-8 text-sm text-muted-foreground">
                正在加载购物 Agent...
              </div>
            </div>
          </main>
        }
      >
        <Dashboard />
      </Suspense>
    </ErrorBoundary>
  );
}
