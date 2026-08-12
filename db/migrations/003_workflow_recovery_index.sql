CREATE INDEX IF NOT EXISTS shopping_sessions_workflow_recovery_idx
  ON shopping_sessions(updated_at ASC)
  WHERE state #>> '{agent_runtime,auto_continue}' = 'true'
    AND state #>> '{agent_runtime,workflow_status}' IN ('running', 'waiting_for_tools');
