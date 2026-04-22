import { ErrorBoundary } from "@/components/error-boundary";
import { HostedConsole } from "@/components/hosted-console";

export default function HostedConsolePage() {
  return (
    <ErrorBoundary>
      <HostedConsole />
    </ErrorBoundary>
  );
}
