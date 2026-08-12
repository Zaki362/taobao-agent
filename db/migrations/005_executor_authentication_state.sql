ALTER TABLE executor_devices
  DROP CONSTRAINT IF EXISTS executor_devices_status_check;

ALTER TABLE executor_devices
  ADD CONSTRAINT executor_devices_status_check
  CHECK (status IN ('online', 'offline', 'authentication_required', 'revoked'));
