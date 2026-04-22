import { ErrorBoundary } from "@/components/error-boundary";
import { Dashboard } from "@/components/dashboard";

export default function HomePage() {
  return (
    <ErrorBoundary>
      <Dashboard />
    </ErrorBoundary>
  );
}
