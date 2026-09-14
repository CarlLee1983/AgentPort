-- S5 records minimal expiry markers before removing retained Task payloads.
-- Existing rows are only indexed/backfilled here; applying the migration never
-- performs retention cleanup.
CREATE TABLE task_expiry_markers (
  expiry_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  queue_order INTEGER NOT NULL,
  terminal_state TEXT NOT NULL CHECK(terminal_state IN ('completed','failed','canceled','interrupted')),
  terminal_committed_at TEXT NOT NULL,
  expired_at TEXT NOT NULL,
  max_event_cursor INTEGER NOT NULL
);
CREATE INDEX task_expiry_markers_scope_agent_queue
  ON task_expiry_markers(scope,agent_id,queue_order);
CREATE INDEX task_expiry_markers_scope_event_cursor
  ON task_expiry_markers(scope,max_event_cursor);
ALTER TABLE operation_receipts ADD COLUMN retained_task_id TEXT;
ALTER TABLE operation_receipts ADD COLUMN expired_at TEXT;
UPDATE operation_receipts
SET retained_task_id=json_extract(result_json,'$.taskId')
WHERE json_valid(result_json) AND json_type(result_json,'$.taskId')='text';
CREATE INDEX operation_receipts_retained_task
  ON operation_receipts(retained_task_id);
CREATE TRIGGER operation_receipts_capture_task_id
AFTER INSERT ON operation_receipts
WHEN NEW.retained_task_id IS NULL
  AND json_valid(NEW.result_json)
  AND json_type(NEW.result_json,'$.taskId')='text'
BEGIN
  UPDATE operation_receipts
  SET retained_task_id=json_extract(NEW.result_json,'$.taskId')
  WHERE scope=NEW.scope AND operation_id=NEW.operation_id;
END;
UPDATE task_reservations
SET control_receipts=MAX(control_receipts,2);
