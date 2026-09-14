-- S4 makes native Runtime questions durable before they can be published.
-- input_state avoids rewriting the S3 lifecycle CHECK while projecting the
-- explicit awaiting_input lifecycle to callers.
ALTER TABLE tasks ADD COLUMN input_state TEXT CHECK(input_state IN ('awaiting_input'));
CREATE TABLE questions (
  question_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  generation TEXT NOT NULL,
  daemon_epoch TEXT NOT NULL,
  launch_profile_id TEXT NOT NULL,
  workspace_identity TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','accepted','closed')),
  delivery_state TEXT NOT NULL CHECK(delivery_state IN ('pending','acknowledged','unknown')),
  answer_fingerprint TEXT,
  answer_json TEXT,
  accepted_actor_principal_id TEXT,
  accepted_at TEXT,
  expires_at TEXT NOT NULL,
  delivery_acknowledged_at TEXT,
  delivery_unknown_at TEXT,
  created_at TEXT NOT NULL,
  CHECK((state='pending' AND answer_fingerprint IS NULL AND answer_json IS NULL AND accepted_actor_principal_id IS NULL AND accepted_at IS NULL) OR (state IN ('accepted','closed') AND answer_fingerprint IS NOT NULL AND answer_json IS NOT NULL AND accepted_actor_principal_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK((delivery_state='acknowledged' AND delivery_acknowledged_at IS NOT NULL) OR (delivery_state!='acknowledged' AND delivery_acknowledged_at IS NULL)),
  CHECK((delivery_state='unknown' AND delivery_unknown_at IS NOT NULL) OR (delivery_state!='unknown' AND delivery_unknown_at IS NULL))
);
CREATE UNIQUE INDEX questions_execution_question ON questions(execution_id, question_id);
CREATE INDEX questions_task_created ON questions(task_id, created_at DESC);
