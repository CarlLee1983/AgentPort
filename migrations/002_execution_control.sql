CREATE TABLE IF NOT EXISTS executions (
  execution_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
  binding_snapshot_id TEXT NOT NULL REFERENCES binding_snapshots(binding_snapshot_id),
  generation TEXT NOT NULL,
  daemon_epoch TEXT NOT NULL,
  launch_profile_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','recovering')),
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(execution_id,generation,daemon_epoch)
);
CREATE INDEX IF NOT EXISTS executions_workspace_state ON executions(workspace_id,state);
CREATE TABLE IF NOT EXISTS workspace_claims (
  workspace_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
  status TEXT NOT NULL CHECK(status IN ('held','quarantined')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
