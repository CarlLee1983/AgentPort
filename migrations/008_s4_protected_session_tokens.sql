CREATE TABLE runtime_session_tokens (
  session_reference TEXT PRIMARY KEY,
  source_execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
  context_id TEXT NOT NULL REFERENCES contexts(context_id),
  binding_snapshot_id TEXT NOT NULL REFERENCES binding_snapshots(binding_snapshot_id),
  runtime_driver TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  workspace_identity TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL CHECK(length(nonce)=12),
  auth_tag BLOB NOT NULL CHECK(length(auth_tag)=16),
  key_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('candidate','current','invalidated')),
  activated_at TEXT,
  invalidated_at TEXT,
  created_at TEXT NOT NULL,
  CHECK((state='candidate' AND activated_at IS NULL AND invalidated_at IS NULL) OR (state='current' AND activated_at IS NOT NULL AND invalidated_at IS NULL) OR (state='invalidated' AND invalidated_at IS NOT NULL))
);
CREATE UNIQUE INDEX runtime_session_tokens_current_context
  ON runtime_session_tokens(context_id)
  WHERE state='current';
CREATE INDEX runtime_session_tokens_context_state
  ON runtime_session_tokens(context_id,state);
