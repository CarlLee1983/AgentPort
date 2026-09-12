CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS binding_snapshots (
  binding_snapshot_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS binding_snapshots_workspace ON binding_snapshots(workspace_id);

CREATE TABLE IF NOT EXISTS contexts (
  context_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  binding_snapshot_id TEXT NOT NULL REFERENCES binding_snapshots(binding_snapshot_id),
  revision INTEGER NOT NULL,
  pause_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL REFERENCES contexts(context_id),
  scope TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued', 'paused', 'canceled')),
  revision INTEGER NOT NULL,
  queue_order INTEGER NOT NULL,
  instruction TEXT NOT NULL,
  reason TEXT,
  execution_limit_seconds INTEGER,
  input_wait_seconds INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_scope_queue ON tasks(scope, queue_order);
CREATE INDEX IF NOT EXISTS tasks_workspace_state ON tasks(agent_id, state);

CREATE TABLE IF NOT EXISTS operation_receipts (
  scope TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  target_id TEXT,
  fingerprint TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, operation_id)
);

CREATE TABLE IF NOT EXISTS task_events (
  scope TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  task_sequence INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, cursor),
  UNIQUE (task_id, task_sequence)
);
CREATE INDEX IF NOT EXISTS task_events_scope_cursor ON task_events(scope, cursor);

CREATE TABLE IF NOT EXISTS task_reservations (
  task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
  control_receipts INTEGER NOT NULL,
  control_events INTEGER NOT NULL,
  control_bytes INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS capacity_metadata (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS product_audit_records (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT,
  method TEXT NOT NULL,
  tool_name TEXT,
  protocol_version TEXT,
  client_name TEXT,
  client_version TEXT,
  client_capabilities_json TEXT,
  result_code TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_audit_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  overwritten_count INTEGER NOT NULL,
  last_gap_operation_id TEXT
);
INSERT OR IGNORE INTO product_audit_state(
  singleton,
  overwritten_count,
  last_gap_operation_id
) VALUES(1, 0, NULL);
