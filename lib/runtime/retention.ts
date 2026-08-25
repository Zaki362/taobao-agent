import {
  isPostgresRuntimeEnabled,
  query,
  withDatabaseAdvisoryLock
} from "@/lib/runtime/database";

export type RuntimeRetentionResult = {
  status: "completed" | "skipped";
  reason?: "local_runtime" | "recently_completed" | "lock_busy";
  deleted: Record<string, number>;
};

function boundedEnvironmentNumber(name: string, fallback: number, min: number, max: number) {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) ? Math.min(max, Math.max(min, configured)) : fallback;
}

export function runtimeRetentionConfiguration() {
  return {
    intervalHours: boundedEnvironmentNumber("SCENECART_RETENTION_INTERVAL_HOURS", 12, 1, 168),
    rateLimitHours: boundedEnvironmentNumber("SCENECART_RATE_LIMIT_RETENTION_HOURS", 48, 24, 720),
    eventDays: boundedEnvironmentNumber("SCENECART_EVENT_RETENTION_DAYS", 30, 7, 365),
    terminalJobDays: boundedEnvironmentNumber("SCENECART_JOB_RETENTION_DAYS", 90, 30, 730),
    archivedSessionDays: boundedEnvironmentNumber("SCENECART_ARCHIVED_SESSION_RETENTION_DAYS", 365, 30, 3_650),
    revokedDeviceDays: boundedEnvironmentNumber("SCENECART_REVOKED_DEVICE_RETENTION_DAYS", 180, 30, 3_650)
  };
}

export async function runRuntimeRetention(): Promise<RuntimeRetentionResult> {
  if (!isPostgresRuntimeEnabled()) {
    return { status: "skipped", reason: "local_runtime", deleted: {} };
  }

  const config = runtimeRetentionConfiguration();
  const locked = await withDatabaseAdvisoryLock("scenecart:runtime-retention", async () => {
    const previous = await query<{ checked_at: Date }>(
      "SELECT checked_at FROM runtime_service_heartbeats WHERE service_name = $1",
      ["runtime-retention"]
    );
    const lastCompletedAt = previous.rows[0]?.checked_at
      ? new Date(previous.rows[0].checked_at).getTime()
      : 0;
    if (Date.now() - lastCompletedAt < config.intervalHours * 60 * 60_000) {
      return { status: "skipped", reason: "recently_completed", deleted: {} } satisfies RuntimeRetentionResult;
    }

    const deleted: Record<string, number> = {};
    deleted.auth_sessions = (await query("DELETE FROM auth_sessions WHERE expires_at <= NOW()")).rowCount ?? 0;
    deleted.rate_limits = (await query(
      "DELETE FROM security_rate_limits WHERE updated_at < NOW() - ($1::text || ' hours')::interval",
      [config.rateLimitHours]
    )).rowCount ?? 0;
    deleted.concurrency_leases = (await query(
      "DELETE FROM security_concurrency_leases WHERE expires_at <= NOW()"
    )).rowCount ?? 0;
    deleted.execution_events = (await query(
      "DELETE FROM execution_events WHERE created_at < NOW() - ($1::text || ' days')::interval",
      [config.eventDays]
    )).rowCount ?? 0;
    deleted.agent_jobs = (await query(
      `DELETE FROM agent_jobs
       WHERE status IN ('completed', 'failed', 'cancelled')
         AND COALESCE(completed_at, updated_at) < NOW() - ($1::text || ' days')::interval`,
      [config.terminalJobDays]
    )).rowCount ?? 0;
    deleted.archived_sessions = (await query(
      `DELETE FROM shopping_sessions
       WHERE state ? 'archived_at'
         AND updated_at < NOW() - ($1::text || ' days')::interval`,
      [config.archivedSessionDays]
    )).rowCount ?? 0;
    deleted.revoked_devices = (await query(
      `DELETE FROM executor_devices
       WHERE status = 'revoked'
         AND updated_at < NOW() - ($1::text || ' days')::interval`,
      [config.revokedDeviceDays]
    )).rowCount ?? 0;

    await query(
      `INSERT INTO runtime_service_heartbeats(service_name, status, metadata, checked_at)
       VALUES($1, 'healthy', $2::jsonb, NOW())
       ON CONFLICT(service_name) DO UPDATE SET
         status = EXCLUDED.status,
         metadata = EXCLUDED.metadata,
         checked_at = EXCLUDED.checked_at`,
      ["runtime-retention", JSON.stringify({ deleted, config })]
    );
    return { status: "completed", deleted } satisfies RuntimeRetentionResult;
  });

  return locked.acquired
    ? locked.value
    : { status: "skipped", reason: "lock_busy", deleted: {} };
}
