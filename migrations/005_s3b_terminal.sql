-- S3-B preserves prior claim rows while adding durable terminal evidence.
ALTER TABLE contexts ADD COLUMN session_reference TEXT;
CREATE TABLE execution_workspace_claims (
  execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('held','quarantined','released')),
  claimed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  released_at TEXT
);
CREATE UNIQUE INDEX execution_workspace_claims_active_workspace
  ON execution_workspace_claims(workspace_id)
  WHERE status IN ('held','quarantined');
INSERT INTO execution_workspace_claims(execution_id,workspace_id,status,claimed_at,updated_at)
  SELECT execution_id,workspace_id,status,created_at,updated_at FROM workspace_claims;
CREATE TABLE execution_terminals (
  execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
  generation TEXT NOT NULL,
  daemon_epoch TEXT NOT NULL,
  launch_profile_id TEXT NOT NULL,
  workspace_identity TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform='linux-cgroup-v2'),
  execution_unit_id TEXT NOT NULL,
  generation_sealed_at TEXT NOT NULL,
  unit_empty_observed_at TEXT NOT NULL,
  terminal_state TEXT NOT NULL CHECK(terminal_state IN ('completed','failed','canceled')),
  result_json TEXT,
  session_reference TEXT,
  final_ordinal INTEGER,
  committed_at TEXT NOT NULL
);
