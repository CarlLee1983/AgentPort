ALTER TABLE executions
  ADD COLUMN stop_reason TEXT
  CHECK (stop_reason IN ('completion', 'cancellation'));
ALTER TABLE executions
  ADD COLUMN stop_reason_committed_at TEXT;
ALTER TABLE executions
  ADD COLUMN recovery_reason TEXT;
ALTER TABLE executions
  ADD COLUMN recovery_started_at TEXT;
ALTER TABLE executions
  ADD COLUMN last_observation_ordinal INTEGER NOT NULL DEFAULT 0
  CHECK (last_observation_ordinal >= 0);
ALTER TABLE executions
  ADD COLUMN observation_bytes INTEGER NOT NULL DEFAULT 0
  CHECK (observation_bytes >= 0);
ALTER TABLE executions
  ADD COLUMN candidate_ordinal INTEGER
  CHECK (candidate_ordinal IS NULL OR candidate_ordinal > 0);

CREATE TABLE execution_observations (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  generation TEXT NOT NULL,
  daemon_epoch TEXT NOT NULL,
  launch_profile_id TEXT NOT NULL,
  workspace_identity TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  kind TEXT NOT NULL CHECK (kind IN ('progress', 'candidate')),
  payload_json TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
  final_ordinal INTEGER CHECK (final_ordinal IS NULL OR final_ordinal > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, ordinal)
);
CREATE UNIQUE INDEX execution_observations_candidate
  ON execution_observations(execution_id)
  WHERE kind = 'candidate';
