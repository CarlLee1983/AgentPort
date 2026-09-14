ALTER TABLE executions ADD COLUMN accumulated_execution_ms INTEGER NOT NULL DEFAULT 0 CHECK(accumulated_execution_ms >= 0);
ALTER TABLE executions ADD COLUMN accounting_phase TEXT NOT NULL DEFAULT 'stopped' CHECK(accounting_phase IN ('active','pure_wait','stopped'));
ALTER TABLE executions ADD COLUMN accounting_phase_started_at TEXT;
ALTER TABLE questions ADD COLUMN closed_at TEXT;
ALTER TABLE questions ADD COLUMN closure_reason TEXT CHECK(closure_reason IN ('expired','canceled','recovery','terminal'));
ALTER TABLE questions ADD COLUMN input_expiry_closed_at TEXT;
ALTER TABLE questions ADD COLUMN tool_activity_status TEXT NOT NULL DEFAULT 'unknown' CHECK(tool_activity_status IN ('idle','unknown'));
ALTER TABLE questions ADD COLUMN tool_activity_observed_at TEXT;
ALTER TABLE context_continuations ADD COLUMN target_task_id TEXT REFERENCES tasks(task_id);
ALTER TABLE context_continuations ADD COLUMN consumed_by_execution_id TEXT REFERENCES executions(execution_id);
UPDATE context_continuations
SET target_task_id = (
  SELECT task_id
  FROM tasks
  WHERE tasks.context_id = context_continuations.context_id
    AND tasks.lifecycle_state IS NULL
    AND tasks.state IN ('queued','paused')
  ORDER BY tasks.queue_order
  LIMIT 1
)
WHERE target_task_id IS NULL;
ALTER TABLE executions ADD COLUMN recovery_resolution TEXT CHECK(recovery_resolution IN ('interrupted'));
CREATE TABLE execution_recovery_stop_confirmations (
  execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
  generation TEXT NOT NULL,
  daemon_epoch TEXT NOT NULL,
  launch_profile_id TEXT NOT NULL,
  workspace_identity TEXT NOT NULL,
  execution_unit_id TEXT NOT NULL,
  generation_sealed_at TEXT NOT NULL,
  unit_empty_observed_at TEXT NOT NULL,
  confirmed_at TEXT NOT NULL
);
