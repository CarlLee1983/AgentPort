// Kept alongside the worker because TypeScript builds do not copy .sql assets.
// migrations/001_durable_admission.sql remains the inspectable migration artifact.
export const initialMigration = `
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS store_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS binding_snapshots (binding_snapshot_id TEXT PRIMARY KEY, scope TEXT NOT NULL, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS binding_snapshots_workspace ON binding_snapshots(workspace_id);
CREATE TABLE IF NOT EXISTS contexts (context_id TEXT PRIMARY KEY, scope TEXT NOT NULL, agent_id TEXT NOT NULL, binding_snapshot_id TEXT NOT NULL REFERENCES binding_snapshots(binding_snapshot_id), revision INTEGER NOT NULL, pause_reason TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, context_id TEXT NOT NULL REFERENCES contexts(context_id), scope TEXT NOT NULL, agent_id TEXT NOT NULL, created_by TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','paused','canceled')), revision INTEGER NOT NULL, queue_order INTEGER NOT NULL, instruction TEXT NOT NULL, reason TEXT, execution_limit_seconds INTEGER, input_wait_seconds INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_scope_queue ON tasks(scope, queue_order);
CREATE INDEX IF NOT EXISTS tasks_workspace_state ON tasks(agent_id, state);
CREATE TABLE IF NOT EXISTS operation_receipts (scope TEXT NOT NULL, operation_id TEXT NOT NULL, operation_type TEXT NOT NULL, target_id TEXT, fingerprint TEXT NOT NULL, actor_principal_id TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope, operation_id));
CREATE TABLE IF NOT EXISTS task_events (scope TEXT NOT NULL, cursor INTEGER NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(task_id), task_sequence INTEGER NOT NULL, revision INTEGER NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope, cursor), UNIQUE(task_id, task_sequence));
CREATE INDEX IF NOT EXISTS task_events_scope_cursor ON task_events(scope, cursor);
CREATE TABLE IF NOT EXISTS task_reservations (task_id TEXT PRIMARY KEY REFERENCES tasks(task_id), control_receipts INTEGER NOT NULL, control_events INTEGER NOT NULL, control_bytes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS capacity_metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS product_audit_records (sequence INTEGER PRIMARY KEY AUTOINCREMENT, principal_id TEXT, method TEXT NOT NULL, tool_name TEXT, protocol_version TEXT, client_name TEXT, client_version TEXT, client_capabilities_json TEXT, result_code TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS product_audit_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), overwritten_count INTEGER NOT NULL, last_gap_operation_id TEXT);
INSERT OR IGNORE INTO product_audit_state(singleton,overwritten_count,last_gap_operation_id) VALUES(1,0,NULL);`;

// migrations/002_execution_control.sql remains the inspectable upgrade artifact.
export const executionControlMigration = `
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
);`;

// migrations/003_s3a_predispatch.sql remains the inspectable upgrade artifact.
// The v2 execution row stays intact; v3 adds bounded observations and the
// ordering metadata needed to derive prepared/stopping/recovering safely.
export const s3aPredispatchMigration = `
ALTER TABLE executions ADD COLUMN stop_reason TEXT CHECK(stop_reason IN ('completion','cancellation'));
ALTER TABLE executions ADD COLUMN stop_reason_committed_at TEXT;
ALTER TABLE executions ADD COLUMN recovery_reason TEXT;
ALTER TABLE executions ADD COLUMN recovery_started_at TEXT;
ALTER TABLE executions ADD COLUMN last_observation_ordinal INTEGER NOT NULL DEFAULT 0 CHECK(last_observation_ordinal >= 0);
ALTER TABLE executions ADD COLUMN observation_bytes INTEGER NOT NULL DEFAULT 0 CHECK(observation_bytes >= 0);
ALTER TABLE executions ADD COLUMN candidate_ordinal INTEGER CHECK(candidate_ordinal IS NULL OR candidate_ordinal > 0);
CREATE TABLE execution_observations (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  generation TEXT NOT NULL,
  daemon_epoch TEXT NOT NULL,
  launch_profile_id TEXT NOT NULL,
  workspace_identity TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  kind TEXT NOT NULL CHECK(kind IN ('progress','candidate')),
  payload_json TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
  final_ordinal INTEGER CHECK(final_ordinal IS NULL OR final_ordinal > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(execution_id,ordinal)
);
CREATE UNIQUE INDEX execution_observations_candidate ON execution_observations(execution_id) WHERE kind='candidate';`;

// migrations/004_s3b_dispatch.sql remains the inspectable upgrade artifact.
export const s3bDispatchMigration = `
ALTER TABLE tasks ADD COLUMN lifecycle_state TEXT CHECK(lifecycle_state IN ('starting','running','stopping','completed','failed','canceled','recovering','interrupted'));
ALTER TABLE executions ADD COLUMN lifecycle_state TEXT CHECK(lifecycle_state IN ('starting','running','stopping','recovering'));`;

// migrations/005_s3b_terminal.sql remains the inspectable upgrade artifact.
// workspace_claims stays readable for prior binaries; v5 uses the new table so
// released claims retain their execution history without blocking the next claim.
export const s3bTerminalMigration = `
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
);`;

// migrations/006_s4_context_queue.sql remains the inspectable upgrade artifact.
// A predecessor is set once when a follow-up is accepted and is never rewritten.
export const s4ContextQueueMigration = `
ALTER TABLE tasks ADD COLUMN predecessor_task_id TEXT REFERENCES tasks(task_id);
CREATE INDEX tasks_context_predecessor ON tasks(context_id, predecessor_task_id);
CREATE INDEX tasks_predecessor_state_queue ON tasks(predecessor_task_id, state, queue_order);`;

// migrations/007_s4_questions.sql remains the inspectable upgrade artifact.
// `input_state` is deliberately separate from the pre-S4 lifecycle CHECK: it
// records a durable input wait without weakening a previously applied schema.
export const s4QuestionsMigration = `
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
CREATE INDEX questions_task_created ON questions(task_id, created_at DESC);`;

// migrations/008_s4_protected_session_tokens.sql remains the inspectable upgrade
// artifact. The vendor token is AES-GCM ciphertext; ordinary observations and
// caller-visible Context rows retain only `session_reference`.
export const s4ProtectedSessionTokensMigration = `
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
  ON runtime_session_tokens(context_id,state);`;

// migrations/009_s4_question_native_relation.sql remains the inspectable
// upgrade artifact. Existing Questions stay readable but lack a deliverable
// native callback relation until a new worker observation supplies one.
export const s4QuestionNativeRelationMigration = `
ALTER TABLE questions ADD COLUMN native_tool_use_id TEXT;
ALTER TABLE questions ADD COLUMN native_request_id TEXT;`;

// migrations/010_s4_context_resume.sql is additive. A Context has at most one
// removable predecessor blocker, while continuation intent remains internal.
export const s4ContextResumeMigration = `
CREATE TABLE context_blockers (
  context_id TEXT PRIMARY KEY REFERENCES contexts(context_id),
  predecessor_task_id TEXT NOT NULL REFERENCES tasks(task_id),
  state TEXT NOT NULL CHECK(state IN ('failed','canceled','interrupted','recovering')),
  created_at TEXT NOT NULL
);
CREATE INDEX context_blockers_predecessor ON context_blockers(predecessor_task_id);
CREATE TABLE context_continuations (
  context_id TEXT PRIMARY KEY REFERENCES contexts(context_id),
  mode TEXT NOT NULL CHECK(mode IN ('preserve','fresh_session')),
  context_summary TEXT,
  native_continuity TEXT NOT NULL CHECK(native_continuity IN ('preserved','abandoned')),
  updated_at TEXT NOT NULL,
  CHECK((mode='preserve' AND context_summary IS NULL AND native_continuity='preserved') OR (mode='fresh_session' AND context_summary IS NOT NULL AND native_continuity='abandoned'))
);`;

// migrations/011_s4_question_accounting.sql adds durable phase checkpoints
// without rewriting earlier execution or Question rows. A legacy active row
// starts stopped and is reconciled before any new dispatch.
export const s4QuestionAccountingMigration = `
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
);`;

// migrations/012_s4_workspace_queue.sql keeps public scope-local queue order
// stable while adding the global admission sequence required for Workspace FIFO.
export const s4WorkspaceQueueMigration = `
CREATE TABLE task_workspace_queue (
  admission_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
  workspace_id TEXT NOT NULL
);
INSERT INTO task_workspace_queue(task_id,workspace_id)
  SELECT tasks.task_id,binding_snapshots.workspace_id
  FROM tasks
  JOIN contexts ON contexts.context_id=tasks.context_id
  JOIN binding_snapshots ON binding_snapshots.binding_snapshot_id=contexts.binding_snapshot_id
  ORDER BY tasks.rowid;
CREATE INDEX task_workspace_queue_workspace_sequence
  ON task_workspace_queue(workspace_id,admission_sequence);`;

// migrations/013_s5_retention_expiry.sql adds only marker and receipt metadata.
// Retention cleanup is an explicit later transaction, never a migration side effect.
export const s5RetentionExpiryMigration = `
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
SET control_receipts=MAX(control_receipts,2);`;
