import type { RuntimeServiceHeartbeat } from "@/lib/runtime/types";

export const WORKFLOW_RECOVERY_SERVICE = "workflow_recovery";

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function workflowRecoveryStaleAfterMs() {
  const intervalMs = Math.max(
    positiveNumber(process.env.SCENECART_RECOVERY_INTERVAL_MS, 30_000),
    10_000
  );
  return Math.max(
    positiveNumber(process.env.SCENECART_RECOVERY_STALE_MS, intervalMs * 4),
    intervalMs * 2,
    60_000
  );
}

export function summarizeWorkflowRecoveryHeartbeat(
  heartbeat: RuntimeServiceHeartbeat | null,
  now = Date.now()
) {
  const staleAfterMs = workflowRecoveryStaleAfterMs();
  const timestamp = heartbeat ? Date.parse(heartbeat.checked_at) : Number.NaN;
  const ageMs = Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null;
  const stale = ageMs === null || ageMs > staleAfterMs;
  const state = !heartbeat
    ? "missing" as const
    : stale
      ? "stale" as const
      : heartbeat.status;

  return {
    state,
    status: heartbeat?.status ?? null,
    last_heartbeat_at: heartbeat?.checked_at ?? null,
    age_ms: ageMs,
    stale_after_ms: staleAfterMs,
    metadata: heartbeat?.metadata ?? {}
  };
}
