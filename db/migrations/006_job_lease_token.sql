ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS lease_token TEXT;

ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS last_auth_failure_token_hash TEXT;
