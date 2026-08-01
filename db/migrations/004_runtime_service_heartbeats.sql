CREATE TABLE IF NOT EXISTS runtime_service_heartbeats (
  service_name TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'failed')),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  checked_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS runtime_service_heartbeats_checked_at_idx
  ON runtime_service_heartbeats(checked_at DESC);
