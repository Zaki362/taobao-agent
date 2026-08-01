import { ExecutorSettings } from "@/components/executor-settings";
import { requireAuthenticatedPageIdentity } from "@/lib/auth/page";

export default async function ExecutorSettingsPage() {
  await requireAuthenticatedPageIdentity("/settings/executor");
  return (
    <main className="min-h-screen">
      <div className="page-shell max-w-[1100px]">
        <ExecutorSettings />
      </div>
    </main>
  );
}
