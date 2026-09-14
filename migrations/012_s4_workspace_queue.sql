-- Dispatch ordering spans Access Scopes because one Agent Workspace may be
-- authorized to Principals in more than one scope. The public queue_order
-- remains scope-local; this internal sequence is the cross-scope FIFO source.
CREATE TABLE task_workspace_queue (
  admission_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
  workspace_id TEXT NOT NULL
);
INSERT INTO task_workspace_queue(task_id, workspace_id)
  SELECT tasks.task_id, binding_snapshots.workspace_id
  FROM tasks
  JOIN contexts ON contexts.context_id = tasks.context_id
  JOIN binding_snapshots
    ON binding_snapshots.binding_snapshot_id = contexts.binding_snapshot_id
  ORDER BY tasks.rowid;
CREATE INDEX task_workspace_queue_workspace_sequence
  ON task_workspace_queue(workspace_id, admission_sequence);
