import { ErrorBoundary } from "@/components/error-boundary";
import { HostedConsole } from "@/components/hosted-console";
import { requirePageIdentity } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export default async function HostedConsolePage() {
  await requirePageIdentity();
  return (
    <ErrorBoundary>
      <HostedConsole />
    </ErrorBoundary>
  );
}
