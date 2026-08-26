CREATE TABLE IF NOT EXISTS security_concurrency_leases (
  key_hash TEXT PRIMARY KEY,
  lease_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS security_concurrency_leases_expires_at_idx
  ON security_concurrency_leases(expires_at);
