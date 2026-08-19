ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS lease_protocol TEXT;

-- Jobs already in flight when protocol v4 is deployed were claimed by v3.
-- New claims always overwrite this field with the current protocol version.
UPDATE agent_jobs
SET lease_protocol = '3'
WHERE lease_protocol IS NULL
  AND lease_token IS NOT NULL
  AND status IN ('leased', 'running');
