import { ExecutorSettings } from "@/components/executor-settings";
import { requirePageIdentity } from "@/lib/auth/page";

export default async function ExecutorSettingsPage() {
  await requirePageIdentity();
  return (
    <main className="min-h-screen">
      <div className="page-shell max-w-[1100px]">
        <ExecutorSettings />
      </div>
    </main>
  );
}
