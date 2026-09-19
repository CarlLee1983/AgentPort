import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import {
  closeSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  statfsSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { MAX_CONTEXT_SUMMARY_BYTES } from "../core/types.js";
import {
  isProtectedClaudeSessionToken,
  isSessionReferenceFor,
  sessionReferenceFor,
} from "../runtime/claude/session-reference.js";
import {
  executionControlMigration,
  initialMigration,
  s3aPredispatchMigration,
  s3bDispatchMigration,
  s3bTerminalMigration,
  s4ContextQueueMigration,
  s4ContextResumeMigration,
  s4QuestionAccountingMigration,
  s4QuestionNativeRelationMigration,
  s4ProtectedSessionTokensMigration,
  s4QuestionsMigration,
  s4WorkspaceQueueMigration,
  s5RetentionExpiryMigration,
} from "./migration.js";

/* The binding's synchronous query API is intentionally confined to this worker.
 * Its declarations expose row values as any, so conversion happens only here. */
/* eslint-disable @typescript-eslint/no-unnecessary-type-conversion */

interface Options {
  databasePath: string;
  recoveryOnly?: boolean;
  auditCapacity?: number;
  activeExecutionCapacity?: number;
  queuePerWorkspace?: number;
  queueGlobal?: number;
  receiptCapacity?: number;
  admissionBytes?: number;
  physicalAdmissionBytes?: number;
  physicalControlReserveBytes?: number;
  taskControlReserveBytes?: number;
  controlReceiptReserve?: number;
  controlEventReserve?: number;
  terminalRetentionDays?: number;
  busyTimeoutMs?: number;
  continuationEncryptionKey?: string;
  registryRevisionFence: SharedArrayBuffer;
  dispatchAdmissionFence: SharedArrayBuffer;
  testCommitBarrier: SharedArrayBuffer;
  testDispatchCommitBarrier: SharedArrayBuffer;
}
interface Request {
  requestId: number;
  command: string;
  payload: Record<string, unknown>;
}
interface Failure {
  code:
    | "operation_conflict"
    | "invalid_state"
    | "queue_capacity"
    | "tombstone_capacity"
    | "storage_capacity"
    | "storage_unavailable"
    | "observation_unavailable"
    | "authorization_changed"
    | "result_expired"
    | "cursor_expired"
    | "not_found";
  message: string;
  taskId?: string;
  incident?: boolean;
}
const options = workerData as Options;
const continuationEncryptionKey = continuationKey(
  options.continuationEncryptionKey,
);
const registryRevisionFence = new Int32Array(options.registryRevisionFence);
const testCommitBarrier = new Int32Array(options.testCommitBarrier);
const testDispatchCommitBarrier = new Int32Array(
  options.testDispatchCommitBarrier,
);
const dispatchAdmissionFence = new Int32Array(options.dispatchAdmissionFence);
const physicalAdmissionBytes =
  options.physicalAdmissionBytes ?? 2 * 1024 * 1024 * 1024;
const physicalControlReserveBytes =
  options.physicalControlReserveBytes ?? 256 * 1024 * 1024;
const physicalCapacityBytes =
  physicalAdmissionBytes + physicalControlReserveBytes;
const taskControlReserveBytes = options.taskControlReserveBytes ?? 128 * 1024;
const terminalRetentionMilliseconds =
  (options.terminalRetentionDays ?? 30) * 24 * 60 * 60 * 1_000;
const controlReservePath = `${options.databasePath}.control-reserve`;
const reserveChunk = Buffer.alloc(64 * 1024, 0xa5);
const db = new Database(options.databasePath);
db.pragma(`busy_timeout = ${String(options.busyTimeoutMs ?? 500)}`);
db.pragma("locking_mode = EXCLUSIVE");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = FULL");
const pageSize = Number(db.pragma("page_size", { simple: true }));
if (taskControlReserveBytes < 32 * pageSize) {
  throw new Error(
    "taskControlReserveBytes must reserve at least 32 database pages",
  );
}
db.pragma(
  `max_page_count = ${String(Math.max(1, Math.floor(physicalCapacityBytes / pageSize)))}`,
);

const hasVersionTable =
  db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    )
    .get() !== undefined;
function hasContiguousSchemaVersions(
  versions: readonly { version: number }[],
  latest: number,
): boolean {
  return (
    versions.length === latest &&
    versions.every(({ version }, index) => Number(version) === index + 1)
  );
}
if (hasVersionTable) {
  const versions = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as { version: number }[];
  if (versions.length === 1 && Number(versions[0]?.version) === 1) {
    db.transaction(() => {
      db.exec(executionControlMigration);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(2, ?)",
      ).run(now());
      db.exec(s3aPredispatchMigration);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(3, ?)",
      ).run(now());
      db.exec(s3bDispatchMigration);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(4, ?)",
      ).run(now());
      db.exec(s3bTerminalMigration);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(5, ?)",
      ).run(now());
    })();
  } else if (
    versions.length === 2 &&
    Number(versions[0]?.version) === 1 &&
    Number(versions[1]?.version) === 2
  ) {
    db.transaction(() => {
      db.exec(s3aPredispatchMigration);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(3, ?)",
      ).run(now());
      db.exec(s3bDispatchMigration);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(4, ?)",
      ).run(now());
      db.exec(s3bTerminalMigration);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(5, ?)",
      ).run(now());
    })();
  } else if (
    versions.length === 3 &&
    Number(versions[0]?.version) === 1 &&
    Number(versions[1]?.version) === 2 &&
    Number(versions[2]?.version) === 3
  ) {
    db.transaction(() => {
      db.exec(s3bDispatchMigration);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(4, ?)",
      ).run(now());
      db.exec(s3bTerminalMigration);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(5, ?)",
      ).run(now());
    })();
  } else if (
    versions.length === 4 &&
    Number(versions[0]?.version) === 1 &&
    Number(versions[1]?.version) === 2 &&
    Number(versions[2]?.version) === 3 &&
    Number(versions[3]?.version) === 4
  ) {
    db.transaction(() => {
      db.exec(s3bTerminalMigration);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(5, ?)",
      ).run(now());
    })();
  } else if (!(
    (versions.length === 5 &&
      Number(versions[0]?.version) === 1 &&
      Number(versions[1]?.version) === 2 &&
      Number(versions[2]?.version) === 3 &&
      Number(versions[3]?.version) === 4 &&
      Number(versions[4]?.version) === 5) ||
    (versions.length === 6 &&
      Number(versions[0]?.version) === 1 &&
      Number(versions[1]?.version) === 2 &&
      Number(versions[2]?.version) === 3 &&
      Number(versions[3]?.version) === 4 &&
      Number(versions[4]?.version) === 5 &&
      Number(versions[5]?.version) === 6) ||
    (versions.length === 7 &&
      Number(versions[0]?.version) === 1 &&
      Number(versions[1]?.version) === 2 &&
      Number(versions[2]?.version) === 3 &&
      Number(versions[3]?.version) === 4 &&
      Number(versions[4]?.version) === 5 &&
      Number(versions[5]?.version) === 6 &&
      Number(versions[6]?.version) === 7) ||
    (versions.length === 8 &&
      Number(versions[0]?.version) === 1 &&
      Number(versions[1]?.version) === 2 &&
      Number(versions[2]?.version) === 3 &&
      Number(versions[3]?.version) === 4 &&
      Number(versions[4]?.version) === 5 &&
      Number(versions[5]?.version) === 6 &&
      Number(versions[6]?.version) === 7 &&
      Number(versions[7]?.version) === 8) ||
    (versions.length === 9 &&
      Number(versions[0]?.version) === 1 &&
      Number(versions[1]?.version) === 2 &&
      Number(versions[2]?.version) === 3 &&
      Number(versions[3]?.version) === 4 &&
      Number(versions[4]?.version) === 5 &&
      Number(versions[5]?.version) === 6 &&
      Number(versions[6]?.version) === 7 &&
      Number(versions[7]?.version) === 8 &&
      Number(versions[8]?.version) === 9) ||
    (versions.length === 10 &&
      Number(versions[0]?.version) === 1 &&
      Number(versions[1]?.version) === 2 &&
      Number(versions[2]?.version) === 3 &&
      Number(versions[3]?.version) === 4 &&
      Number(versions[4]?.version) === 5 &&
      Number(versions[5]?.version) === 6 &&
      Number(versions[6]?.version) === 7 &&
      Number(versions[7]?.version) === 8 &&
      Number(versions[8]?.version) === 9 &&
      Number(versions[9]?.version) === 10) ||
    hasContiguousSchemaVersions(versions, 11) ||
    hasContiguousSchemaVersions(versions, 12) ||
    hasContiguousSchemaVersions(versions, 13)
  )) {
    throw new Error("unsupported durable admission schema version");
  }
} else {
  db.transaction(() => {
    db.exec(initialMigration);
    db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES(1, ?)",
    ).run(now());
    db.exec(executionControlMigration);
    db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES(2, ?)",
    ).run(now());
    db.exec(s3aPredispatchMigration);
    db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES(3, ?)",
    ).run(now());
    db.exec(s3bDispatchMigration);
    db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES(4, ?)",
    ).run(now());
    db.exec(s3bTerminalMigration);
    db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES(5, ?)",
    ).run(now());
  })();
}

const migrationVersions = db
  .prepare("SELECT version FROM schema_migrations ORDER BY version")
  .all() as { version: number }[];
if (options.recoveryOnly !== true && migrationVersions.length === 5) {
  db.transaction(() => {
    db.exec(s4ContextQueueMigration);
    db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES(6, ?)",
    ).run(now());
  })();
} else if (!(
  (migrationVersions.length === 6 &&
    Number(migrationVersions[5]?.version) === 6) ||
  (migrationVersions.length === 7 &&
    Number(migrationVersions[6]?.version) === 7) ||
  (migrationVersions.length === 8 &&
    Number(migrationVersions[7]?.version) === 8) ||
  (migrationVersions.length === 9 &&
    Number(migrationVersions[8]?.version) === 9) ||
  (migrationVersions.length === 10 &&
    Number(migrationVersions[9]?.version) === 10) ||
  hasContiguousSchemaVersions(migrationVersions, 11) ||
  hasContiguousSchemaVersions(migrationVersions, 12) ||
  hasContiguousSchemaVersions(migrationVersions, 13) ||
  (options.recoveryOnly === true &&
    (migrationVersions.length === 5 ||
      migrationVersions.length === 6 ||
      migrationVersions.length === 7 ||
      migrationVersions.length === 8 ||
      migrationVersions.length === 9 ||
      migrationVersions.length === 10 ||
      migrationVersions.length === 11 ||
      migrationVersions.length === 12 ||
      migrationVersions.length === 13))
)) {
  throw new Error("unsupported durable admission schema version");
}

const s4MigrationVersions = db
  .prepare("SELECT version FROM schema_migrations ORDER BY version")
  .all() as { version: number }[];
if (options.recoveryOnly !== true && s4MigrationVersions.length === 6) {
  db.transaction(() => {
    db.exec(s4QuestionsMigration);
    db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES(7, ?)",
    ).run(now());
  })();
} else if (!(
  (s4MigrationVersions.length === 7 &&
    Number(s4MigrationVersions[6]?.version) === 7) ||
  (s4MigrationVersions.length === 8 &&
    Number(s4MigrationVersions[7]?.version) === 8) ||
  (s4MigrationVersions.length === 9 &&
    Number(s4MigrationVersions[8]?.version) === 9) ||
  (s4MigrationVersions.length === 10 &&
    Number(s4MigrationVersions[9]?.version) === 10) ||
  hasContiguousSchemaVersions(s4MigrationVersions, 11) ||
  hasContiguousSchemaVersions(s4MigrationVersions, 12) ||
  hasContiguousSchemaVersions(s4MigrationVersions, 13) ||
  (options.recoveryOnly === true &&
    (s4MigrationVersions.length === 5 ||
      s4MigrationVersions.length === 6 ||
      s4MigrationVersions.length === 7 ||
      s4MigrationVersions.length === 8 ||
      s4MigrationVersions.length === 9 ||
      s4MigrationVersions.length === 10 ||
      s4MigrationVersions.length === 11 ||
      s4MigrationVersions.length === 12 ||
      s4MigrationVersions.length === 13))
)) {
  throw new Error("unsupported durable admission schema version");
}

const protectedSessionMigrationVersions = db
  .prepare("SELECT version FROM schema_migrations ORDER BY version")
  .all() as { version: number }[];
if (
  options.recoveryOnly !== true &&
  protectedSessionMigrationVersions.length === 7
) {
  db.transaction(() => {
    db.exec(s4ProtectedSessionTokensMigration);
    db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES(8, ?)",
    ).run(now());
  })();
} else if (!(
  (protectedSessionMigrationVersions.length === 8 &&
    Number(protectedSessionMigrationVersions[7]?.version) === 8) ||
  (protectedSessionMigrationVersions.length === 9 &&
    Number(protectedSessionMigrationVersions[8]?.version) === 9) ||
  (protectedSessionMigrationVersions.length === 10 &&
    Number(protectedSessionMigrationVersions[9]?.version) === 10) ||
  hasContiguousSchemaVersions(protectedSessionMigrationVersions, 11) ||
  hasContiguousSchemaVersions(protectedSessionMigrationVersions, 12) ||
  hasContiguousSchemaVersions(protectedSessionMigrationVersions, 13) ||
  (options.recoveryOnly === true &&
    (protectedSessionMigrationVersions.length === 5 ||
      protectedSessionMigrationVersions.length === 6 ||
      protectedSessionMigrationVersions.length === 7 ||
      protectedSessionMigrationVersions.length === 8 ||
      protectedSessionMigrationVersions.length === 9 ||
      protectedSessionMigrationVersions.length === 10 ||
      protectedSessionMigrationVersions.length === 11 ||
      protectedSessionMigrationVersions.length === 12 ||
      protectedSessionMigrationVersions.length === 13))
)) {
  throw new Error("unsupported durable admission schema version");
}

const questionRelationMigrationVersions = db
  .prepare("SELECT version FROM schema_migrations ORDER BY version")
  .all() as { version: number }[];
if (
  options.recoveryOnly !== true &&
  questionRelationMigrationVersions.length === 8
) {
  db.transaction(() => {
    db.exec(s4QuestionNativeRelationMigration);
    db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES(9, ?)",
    ).run(now());
  })();
} else if (!(
  (questionRelationMigrationVersions.length === 9 &&
    Number(questionRelationMigrationVersions[8]?.version) === 9) ||
  (questionRelationMigrationVersions.length === 10 &&
    Number(questionRelationMigrationVersions[9]?.version) === 10) ||
  hasContiguousSchemaVersions(questionRelationMigrationVersions, 11) ||
  hasContiguousSchemaVersions(questionRelationMigrationVersions, 12) ||
  hasContiguousSchemaVersions(questionRelationMigrationVersions, 13) ||
  (options.recoveryOnly === true &&
    (questionRelationMigrationVersions.length === 5 ||
      questionRelationMigrationVersions.length === 6 ||
      questionRelationMigrationVersions.length === 7 ||
      questionRelationMigrationVersions.length === 8 ||
      questionRelationMigrationVersions.length === 9 ||
      questionRelationMigrationVersions.length === 10 ||
      questionRelationMigrationVersions.length === 11 ||
      questionRelationMigrationVersions.length === 12 ||
      questionRelationMigrationVersions.length === 13))
)) {
  throw new Error("unsupported durable admission schema version");
}

const contextResumeMigrationVersions = db
  .prepare("SELECT version FROM schema_migrations ORDER BY version")
  .all() as { version: number }[];
if (
  options.recoveryOnly !== true &&
  contextResumeMigrationVersions.length === 9
) {
  db.transaction(() => {
    db.exec(s4ContextResumeMigration);
    db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES(10, ?)",
    ).run(now());
  })();
} else if (!(
  (contextResumeMigrationVersions.length === 10 &&
    Number(contextResumeMigrationVersions[9]?.version) === 10) ||
  hasContiguousSchemaVersions(contextResumeMigrationVersions, 11) ||
  hasContiguousSchemaVersions(contextResumeMigrationVersions, 12) ||
  hasContiguousSchemaVersions(contextResumeMigrationVersions, 13) ||
  (options.recoveryOnly === true &&
    (contextResumeMigrationVersions.length === 5 ||
      contextResumeMigrationVersions.length === 6 ||
      contextResumeMigrationVersions.length === 7 ||
      contextResumeMigrationVersions.length === 8 ||
      contextResumeMigrationVersions.length === 9 ||
      contextResumeMigrationVersions.length === 10 ||
      contextResumeMigrationVersions.length === 11 ||
      contextResumeMigrationVersions.length === 12 ||
      contextResumeMigrationVersions.length === 13))
)) {
  throw new Error("unsupported durable admission schema version");
}

const questionAccountingMigrationVersions = db
  .prepare("SELECT version FROM schema_migrations ORDER BY version")
  .all() as { version: number }[];
if (
  options.recoveryOnly !== true &&
  questionAccountingMigrationVersions.length === 10
) {
  db.transaction(() => {
    db.exec(s4QuestionAccountingMigration);
    db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES(11, ?)",
    ).run(now());
  })();
} else if (!(
  hasContiguousSchemaVersions(questionAccountingMigrationVersions, 11) ||
  hasContiguousSchemaVersions(questionAccountingMigrationVersions, 12) ||
  hasContiguousSchemaVersions(questionAccountingMigrationVersions, 13) ||
  (options.recoveryOnly === true &&
    (questionAccountingMigrationVersions.length === 5 ||
      questionAccountingMigrationVersions.length === 6 ||
      questionAccountingMigrationVersions.length === 7 ||
      questionAccountingMigrationVersions.length === 8 ||
      questionAccountingMigrationVersions.length === 9 ||
      questionAccountingMigrationVersions.length === 10 ||
      questionAccountingMigrationVersions.length === 11 ||
      questionAccountingMigrationVersions.length === 12 ||
      questionAccountingMigrationVersions.length === 13))
)) {
  throw new Error("unsupported durable admission schema version");
}

const workspaceQueueMigrationVersions = db
  .prepare("SELECT version FROM schema_migrations ORDER BY version")
  .all() as { version: number }[];
if (
  options.recoveryOnly !== true &&
  workspaceQueueMigrationVersions.length === 11
) {
  db.transaction(() => {
    db.exec(s4WorkspaceQueueMigration);
    db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES(12, ?)",
    ).run(now());
  })();
} else if (!(
  hasContiguousSchemaVersions(workspaceQueueMigrationVersions, 12) ||
  hasContiguousSchemaVersions(workspaceQueueMigrationVersions, 13) ||
  (options.recoveryOnly === true &&
    workspaceQueueMigrationVersions.length >= 5 &&
    workspaceQueueMigrationVersions.length <= 13)
)) {
  throw new Error("unsupported durable admission schema version");
}

const retentionMigrationVersions = db
  .prepare("SELECT version FROM schema_migrations ORDER BY version")
  .all() as { version: number }[];
if (options.recoveryOnly !== true && retentionMigrationVersions.length === 12) {
  db.transaction(() => {
    db.exec(s5RetentionExpiryMigration);
    db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES(13, ?)",
    ).run(now());
  })();
} else if (!(
  hasContiguousSchemaVersions(retentionMigrationVersions, 13) ||
  (options.recoveryOnly === true &&
    retentionMigrationVersions.length >= 5 &&
    retentionMigrationVersions.length <= 13)
)) {
  throw new Error("unsupported durable admission schema version");
}

const requiredTables = [
  "binding_snapshots",
  "capacity_metadata",
  "contexts",
  "executions",
  "execution_observations",
  "operation_receipts",
  "product_audit_records",
  "product_audit_state",
  "schema_migrations",
  "store_metadata",
  "task_events",
  "task_reservations",
  "tasks",
  "workspace_claims",
  "execution_workspace_claims",
  "execution_terminals",
  "runtime_session_tokens",
  "questions",
  "context_blockers",
  "context_continuations",
  "execution_recovery_stop_confirmations",
];
const actualTables = new Set(
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[]
  ).map(({ name }) => name),
);
if (requiredTables.some((name) => !actualTables.has(name))) {
  throw new Error("durable admission schema is incomplete");
}
if (
  Number(retentionMigrationVersions.at(-1)?.version) >= 12 &&
  !actualTables.has("task_workspace_queue")
) {
  throw new Error("durable Workspace queue schema is incomplete");
}
if (
  Number(retentionMigrationVersions.at(-1)?.version) >= 13 &&
  !actualTables.has("task_expiry_markers")
) {
  throw new Error("durable retention schema is incomplete");
}
const receiptColumns = new Set(
  (db.pragma("table_info(operation_receipts)") as { name: string }[]).map(
    ({ name }) => name,
  ),
);
if (!receiptColumns.has("actor_principal_id")) {
  throw new Error("durable admission receipt schema is incompatible");
}
if (
  Number(retentionMigrationVersions.at(-1)?.version) >= 13 &&
  (!receiptColumns.has("retained_task_id") || !receiptColumns.has("expired_at"))
) {
  throw new Error("durable retention receipt schema is incompatible");
}
const taskColumns = new Set(
  (db.pragma("table_info(tasks)") as { name: string }[]).map(
    ({ name }) => name,
  ),
);
if (!taskColumns.has("input_state")) {
  throw new Error("durable admission task input schema is incompatible");
}
const questionColumns = new Set(
  (db.pragma("table_info(questions)") as { name: string }[]).map(
    ({ name }) => name,
  ),
);
if (
  Number(questionRelationMigrationVersions.at(-1)?.version) >= 9 &&
  (!questionColumns.has("native_tool_use_id") ||
    !questionColumns.has("native_request_id"))
) {
  throw new Error("durable Question schema is incompatible");
}
const executionColumns = new Set(
  (db.pragma("table_info(executions)") as { name: string }[]).map(
    ({ name }) => name,
  ),
);
const continuationColumns = new Set(
  (db.pragma("table_info(context_continuations)") as { name: string }[]).map(
    ({ name }) => name,
  ),
);
if (
  Number(questionAccountingMigrationVersions.at(-1)?.version) >= 11 &&
  (![
    "closed_at",
    "closure_reason",
    "input_expiry_closed_at",
    "tool_activity_status",
    "tool_activity_observed_at",
  ].every((column) => questionColumns.has(column)) ||
    ![
      "accumulated_execution_ms",
      "accounting_phase",
      "accounting_phase_started_at",
      "recovery_resolution",
    ].every((column) => executionColumns.has(column)) ||
    !["target_task_id", "consumed_by_execution_id"].every((column) =>
      continuationColumns.has(column),
    ))
) {
  throw new Error("durable S4 accounting schema is incompatible");
}
const auditStateColumns = new Set(
  (db.pragma("table_info(product_audit_state)") as { name: string }[]).map(
    ({ name }) => name,
  ),
);
if (!auditStateColumns.has("last_gap_operation_id")) {
  throw new Error("durable admission audit schema is incompatible");
}
// In EXCLUSIVE locking mode this write transaction retains the local database
// lock until the connection closes, so a second daemon cannot start concurrently.
db.exec("BEGIN IMMEDIATE; COMMIT;");
let failNextCommit = false;
let failNextStorageBusy = false;
let failNextStorageFull = false;
let failNextStorageIo = false;
let failNextReadDiagnostic = false;
let nextReadDiagnosticMarker = "AP014-PRIVATE-DIAGNOSTIC-MARKER";
let failNextAuditGap = false;
let failAuditGapPermanently = false;
initializeCapacityMetadata();
db.transaction(() => {
  enforceAuditCapacity();
})();
const controlReserveFile = openSync(controlReservePath, "a+");
reconcilePhysicalControlReserve();
if (statSync(options.databasePath).dev !== statSync(controlReservePath).dev) {
  throw new Error(
    "database and physical control reserve must share a filesystem",
  );
}

function now(): string {
  return new Date().toISOString();
}

function continuationKey(value: unknown): Buffer | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error("protected continuation key is invalid");
  }
  const key = Buffer.from(value, "base64url");
  if (key.byteLength !== 32) {
    throw new Error("protected continuation key is invalid");
  }
  return key;
}

function continuationAssociatedData(row: Record<string, unknown>): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      sessionReference: String(row.session_reference),
      contextId: String(row.context_id),
      executionId: String(row.execution_id),
      generation: String(row.generation),
      daemonEpoch: String(row.daemon_epoch),
      launchProfileId: String(row.launch_profile_id),
      workspaceIdentity: String(row.workspace_id),
      bindingSnapshotId: String(row.binding_snapshot_id),
      runtimeDriver: String(row.runtime_driver),
      runtimeVersion: String(row.runtime_version),
    }),
    "utf8",
  );
}

function encryptContinuationToken(
  token: string,
  row: Record<string, unknown>,
): { ciphertext: Buffer; nonce: Buffer; authTag: Buffer; keyId: string } {
  if (continuationEncryptionKey === undefined) {
    throw new Error("protected continuation key is unavailable");
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    continuationEncryptionKey,
    nonce,
  );
  cipher.setAAD(continuationAssociatedData(row));
  return {
    ciphertext: Buffer.concat([cipher.update(token, "utf8"), cipher.final()]),
    nonce,
    authTag: cipher.getAuthTag(),
    keyId: createHash("sha256")
      .update(continuationEncryptionKey)
      .digest("hex")
      .slice(0, 24),
  };
}

function decryptContinuationToken(row: Record<string, unknown>): string {
  if (
    continuationEncryptionKey === undefined ||
    !Buffer.isBuffer(row.ciphertext) ||
    !Buffer.isBuffer(row.nonce) ||
    !Buffer.isBuffer(row.auth_tag)
  ) {
    throwFailure("invalid_state", "protected continuation is unavailable");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      continuationEncryptionKey,
      row.nonce,
    );
    decipher.setAAD(continuationAssociatedData(row));
    decipher.setAuthTag(row.auth_tag);
    const token = Buffer.concat([
      decipher.update(row.ciphertext),
      decipher.final(),
    ]).toString("utf8");
    if (!isProtectedClaudeSessionToken(token)) {
      throw new Error("invalid protected token");
    }
    return token;
  } catch {
    throwFailure("invalid_state", "protected continuation is unavailable");
  }
}

function continuationBinding(
  row: Record<string, unknown>,
): { runtimeDriver: string; runtimeVersion: string } | undefined {
  try {
    const payload = JSON.parse(String(row.binding_payload)) as unknown;
    if (
      !isRecord(payload) ||
      typeof payload.runtimeDriver !== "string" ||
      payload.runtimeDriver.length === 0 ||
      typeof payload.runtimeVersion !== "string" ||
      payload.runtimeVersion.length === 0
    ) {
      return undefined;
    }
    return {
      runtimeDriver: payload.runtimeDriver,
      runtimeVersion: payload.runtimeVersion,
    };
  } catch {
    return undefined;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function capacityValue(key: string): number {
  const row = db
    .prepare("SELECT value FROM capacity_metadata WHERE key=?")
    .get(key) as { value: number } | undefined;
  return Number(row?.value ?? 0);
}
function changeCapacity(key: string, delta: number): void {
  db.prepare(
    "INSERT INTO capacity_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value",
  ).run(key, delta);
}
function workspaceCapacityKey(workspaceId: string): string {
  return `active_workspace:${workspaceId}`;
}
function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return 0;
    throw error;
  }
}
function allocatedFileBytes(path: string): number {
  try {
    return Number(statSync(path).blocks) * 512;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return 0;
    throw error;
  }
}
function physicalUsage() {
  const databaseBytes = fileBytes(options.databasePath);
  const walBytes = fileBytes(`${options.databasePath}-wal`);
  const controlReserveBytes = fileBytes(controlReservePath);
  const allocatedDatabaseBytes = allocatedFileBytes(options.databasePath);
  const allocatedWalBytes = allocatedFileBytes(`${options.databasePath}-wal`);
  const allocatedControlReserveBytes = allocatedFileBytes(controlReservePath);
  const accountedDatabaseAndWalBytes = Math.max(
    databaseBytes + walBytes,
    allocatedDatabaseBytes + allocatedWalBytes,
  );
  return {
    databaseBytes,
    walBytes,
    totalBytes: databaseBytes + walBytes,
    allocatedDatabaseBytes,
    allocatedWalBytes,
    accountedDatabaseAndWalBytes,
    controlReserveBytes,
    allocatedControlReserveBytes,
    physicalTotalBytes:
      accountedDatabaseAndWalBytes +
      Math.max(controlReserveBytes, allocatedControlReserveBytes),
  };
}
function availableFilesystemBytes(): number {
  const filesystem = statfsSync(dirname(options.databasePath));
  return Number(filesystem.bavail) * Number(filesystem.bsize);
}
function checkpointWal(): void {
  db.pragma("wal_checkpoint(TRUNCATE)");
}
function reusableFreelistBytes(boundary: number): number {
  if (boundary !== physicalAdmissionBytes) return 0;
  const usage = physicalUsage();
  if (usage.walBytes !== 0 || usage.allocatedWalBytes !== 0) return 0;
  return Number(db.pragma("freelist_count", { simple: true })) * pageSize;
}
function requirePhysicalHeadroom(
  boundary: number,
  estimatedGrowth = 0,
  filesystemReserve = 0,
): void {
  const usage = physicalUsage();
  const projectedFileGrowth = Math.max(
    0,
    estimatedGrowth - reusableFreelistBytes(boundary),
  );
  if (
    usage.accountedDatabaseAndWalBytes + projectedFileGrowth > boundary ||
    usage.physicalTotalBytes + estimatedGrowth + filesystemReserve >
      physicalCapacityBytes ||
    availableFilesystemBytes() < estimatedGrowth + filesystemReserve
  ) {
    throwFailure("storage_capacity", "physical storage capacity is exhausted");
  }
}
function resizePhysicalControlReserve(targetBytes: number): void {
  if (
    !Number.isSafeInteger(targetBytes) ||
    targetBytes < 0 ||
    targetBytes > physicalControlReserveBytes
  ) {
    throw new Error("invalid physical control reserve target");
  }
  const currentBytes = fileBytes(controlReservePath);
  if (currentBytes > targetBytes) {
    ftruncateSync(controlReserveFile, targetBytes);
  } else {
    let offset = currentBytes;
    while (offset < targetBytes) {
      const length = Math.min(reserveChunk.byteLength, targetBytes - offset);
      const written = writeSync(
        controlReserveFile,
        reserveChunk,
        0,
        length,
        offset,
      );
      if (written !== length) {
        throw new Error("physical control reserve write was incomplete");
      }
      offset += written;
    }
  }
  fsyncSync(controlReserveFile);
  const physical = physicalUsage();
  if (
    physical.controlReserveBytes !== targetBytes ||
    physical.allocatedControlReserveBytes < targetBytes
  ) {
    throw new Error("physical control reserve is sparse or incomplete");
  }
}
function reconcilePhysicalControlReserve(): void {
  resizePhysicalControlReserve(capacityValue("reserved_control_bytes"));
}
function growPhysicalControlReserve(bytes: number): void {
  const target = fileBytes(controlReservePath) + bytes;
  requirePhysicalHeadroom(physicalAdmissionBytes, 0, bytes);
  resizePhysicalControlReserve(target);
}
function releasePhysicalControlReserve(bytes: number): void {
  resizePhysicalControlReserve(fileBytes(controlReservePath) - bytes);
}
function submitGrowthEstimate(
  instruction: string,
  binding: Record<string, unknown>,
): number {
  return (
    Buffer.byteLength(instruction) +
    Buffer.byteLength(JSON.stringify(binding)) +
    16 * pageSize
  );
}
function auditText(value: unknown, maximumBytes: number): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return Buffer.byteLength(value, "utf8") <= maximumBytes ? value : null;
}
function recordAudit(p: Record<string, unknown>): void {
  const method = auditText(p.method, 128);
  const resultCode = auditText(p.resultCode, 128);
  const createdAt = auditText(p.createdAt, 64);
  if (method === null || resultCode === null || createdAt === null) {
    throw new Error("invalid sanitized product audit record");
  }
  const capabilities = auditText(p.clientCapabilitiesJson, 4 * 1024);
  const estimatedGrowth =
    Buffer.byteLength(method) +
    Buffer.byteLength(resultCode) +
    Buffer.byteLength(createdAt) +
    Buffer.byteLength(capabilities ?? "") +
    4 * pageSize;
  checkpointWal();
  requirePhysicalHeadroom(physicalAdmissionBytes, estimatedGrowth);
  db.transaction(() => {
    enforceAuditCapacity(1);
    db.prepare(
      "INSERT INTO product_audit_records(principal_id,method,tool_name,protocol_version,client_name,client_version,client_capabilities_json,result_code,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      auditText(p.principalId, 128),
      method,
      auditText(p.toolName, 128),
      auditText(p.protocolVersion, 64),
      auditText(p.clientName, 128),
      auditText(p.clientVersion, 128),
      capabilities,
      resultCode,
      createdAt,
    );
    requirePhysicalHeadroom(physicalAdmissionBytes);
  })();
}
function recordAuditGap(p: Record<string, unknown>): void {
  const count = Number(p.count);
  const operationId = auditText(p.operationId, 128);
  if (!Number.isSafeInteger(count) || count < 1 || operationId === null) {
    throw new Error("invalid product audit gap count");
  }
  if (failAuditGapPermanently || failNextAuditGap) {
    failNextAuditGap = false;
    throwFailure("storage_unavailable", "injected product audit gap failure");
  }
  db.transaction(() => {
    const state = db
      .prepare(
        "SELECT last_gap_operation_id AS operationId FROM product_audit_state WHERE singleton=1",
      )
      .get() as { operationId: string | null };
    if (state.operationId === operationId) return;
    db.prepare(
      "UPDATE product_audit_state SET overwritten_count=overwritten_count+?,last_gap_operation_id=? WHERE singleton=1",
    ).run(count, operationId);
  })();
}
function enforceAuditCapacity(incomingRecords = 0): void {
  const capacity = options.auditCapacity ?? 10_000;
  const count = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM product_audit_records")
        .get() as { count: number }
    ).count,
  );
  const remove = Math.max(0, count - capacity + incomingRecords);
  if (remove === 0) return;
  const deleted = db
    .prepare(
      "DELETE FROM product_audit_records WHERE sequence IN (SELECT sequence FROM product_audit_records ORDER BY sequence LIMIT ?)",
    )
    .run(remove);
  db.prepare(
    "UPDATE product_audit_state SET overwritten_count=overwritten_count+? WHERE singleton=1",
  ).run(deleted.changes);
}
function initializeCapacityMetadata(): void {
  const pausedControlReserveBytes =
    taskControlReserveBytes - Math.floor(taskControlReserveBytes / 2);
  const unspentControlReceipts = actualTables.has("task_expiry_markers")
    ? 2
    : 1;
  const invalidReservation = db
    .prepare(
      `SELECT t.task_id
       FROM tasks t
       LEFT JOIN task_reservations r ON r.task_id=t.task_id
       LEFT JOIN executions e ON e.task_id=t.task_id
       WHERE t.state IN ('queued','paused')
         AND COALESCE(t.lifecycle_state,'') NOT IN ('completed','failed','canceled','interrupted')
         AND (
           r.task_id IS NULL
           OR r.control_receipts < CASE
             WHEN t.state='paused'
               AND t.reason='execution_stopping'
               AND e.stop_reason='cancellation'
               AND EXISTS (SELECT 1 FROM operation_receipts o WHERE o.scope=t.scope AND o.operation_type='cancel' AND o.target_id=t.task_id)
               AND EXISTS (SELECT 1 FROM task_events ev WHERE ev.task_id=t.task_id AND ev.event_type='cancel_requested') THEN 0
            WHEN EXISTS (
              SELECT 1 FROM questions q
              JOIN operation_receipts reply ON reply.scope=t.scope
                AND reply.operation_type='reply'
                AND reply.target_id=q.question_id
              WHERE q.task_id=t.task_id
                AND q.accepted_at IS NOT NULL
                AND q.answer_fingerprint IS NOT NULL
            ) THEN 1
             ELSE ?
           END
           OR r.control_bytes < CASE
            WHEN EXISTS (
              SELECT 1 FROM questions q
              JOIN operation_receipts reply ON reply.scope=t.scope
                AND reply.operation_type='reply'
                AND reply.target_id=q.question_id
              WHERE q.task_id=t.task_id
                AND q.accepted_at IS NOT NULL
                AND q.answer_fingerprint IS NOT NULL
            ) THEN ?
             WHEN t.state='queued' THEN ?
             ELSE ?
           END
           OR r.control_events < CASE t.state WHEN 'queued' THEN 2 ELSE 1 END
         )
       LIMIT 1`,
    )
    .get(
      unspentControlReceipts,
      pausedControlReserveBytes,
      taskControlReserveBytes,
      pausedControlReserveBytes,
    ) as { task_id: string } | undefined;
  if (invalidReservation !== undefined) {
    throw new Error("active Task control reservation ledger is inconsistent");
  }
  db.transaction(() => {
    db.prepare("DELETE FROM capacity_metadata").run();
    db.prepare("INSERT INTO capacity_metadata(key,value) VALUES(?,?)").run(
      "general_receipts",
      (
        db
          .prepare(
            "SELECT COUNT(*) AS value FROM operation_receipts WHERE operation_type IN ('submit','edit','resume')",
          )
          .get() as { value: number }
      ).value,
    );
    db.prepare("INSERT INTO capacity_metadata(key,value) VALUES(?,?)").run(
      "admission_bytes",
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(LENGTH(CAST(instruction AS BLOB))),0) AS value FROM tasks",
          )
          .get() as { value: number }
      ).value,
    );
    db.prepare("INSERT INTO capacity_metadata(key,value) VALUES(?,?)").run(
      "active_global",
      (
        db
          .prepare(
            "SELECT COUNT(*) AS value FROM tasks WHERE state IN ('queued','paused') AND COALESCE(lifecycle_state,'') NOT IN ('completed','failed','canceled','interrupted')",
          )
          .get() as { value: number }
      ).value,
    );
    db.prepare("INSERT INTO capacity_metadata(key,value) VALUES(?,?)").run(
      "reserved_control_bytes",
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(control_bytes),0) AS value FROM task_reservations",
          )
          .get() as { value: number }
      ).value,
    );
    const workspaces = db
      .prepare(
        "SELECT b.workspace_id AS workspace_id, COUNT(*) AS value FROM tasks t JOIN contexts c ON c.context_id=t.context_id JOIN binding_snapshots b ON b.binding_snapshot_id=c.binding_snapshot_id WHERE t.state IN ('queued','paused') AND COALESCE(t.lifecycle_state,'') NOT IN ('completed','failed','canceled','interrupted') GROUP BY b.workspace_id",
      )
      .all() as { workspace_id: string; value: number }[];
    for (const workspace of workspaces) {
      db.prepare("INSERT INTO capacity_metadata(key,value) VALUES(?,?)").run(
        workspaceCapacityKey(workspace.workspace_id),
        workspace.value,
      );
    }
  })();
}
function task(row: Record<string, unknown>) {
  const context = db
    .prepare("SELECT revision FROM contexts WHERE context_id=?")
    .get(row.context_id) as { revision: number } | undefined;
  if (context === undefined) throw new Error("Task Context is missing");
  const blocker = db
    .prepare(
      "SELECT predecessor_task_id,state FROM context_blockers WHERE context_id=?",
    )
    .get(row.context_id) as
    { predecessor_task_id: string; state: string } | undefined;
  const continuation = db
    .prepare(
      "SELECT mode,native_continuity FROM context_continuations WHERE context_id=? AND target_task_id=?",
    )
    .get(row.context_id, row.task_id) as
    | {
        mode: "preserve" | "fresh_session";
        native_continuity: "preserved" | "abandoned";
      }
    | undefined;
  const terminal = db
    .prepare(
      "SELECT et.terminal_state,et.result_json FROM execution_terminals et JOIN executions e ON e.execution_id=et.execution_id WHERE e.task_id=?",
    )
    .get(row.task_id) as
    | {
        terminal_state: "completed" | "failed" | "canceled";
        result_json: string | null;
      }
    | undefined;
  let result: {
    kind: "completed" | "failed" | "canceled";
    summary: string | null;
  } | null = null;
  if (terminal !== undefined) {
    const payload =
      terminal.result_json === null
        ? undefined
        : (JSON.parse(terminal.result_json) as Record<string, unknown>);
    result = {
      kind: terminal.terminal_state,
      summary: typeof payload?.summary === "string" ? payload.summary : null,
    };
  }
  return {
    taskId: row.task_id,
    contextId: row.context_id,
    contextRevision: context.revision,
    accessScopeId: row.scope,
    agentId: row.agent_id,
    createdBy: row.created_by,
    state:
      (row.task_input_state ?? row.input_state) === "awaiting_input" &&
      row.lifecycle_state === "running"
        ? "awaiting_input"
        : (row.lifecycle_state ?? row.state),
    reason: row.reason,
    revision: row.revision,
    queueOrder: row.queue_order,
    predecessorTaskId:
      typeof row.predecessor_task_id === "string"
        ? row.predecessor_task_id
        : null,
    blocker:
      blocker === undefined
        ? null
        : {
            predecessorTaskId: blocker.predecessor_task_id,
            state: blocker.state as
              "failed" | "canceled" | "interrupted" | "recovering",
          },
    continuation:
      continuation === undefined
        ? null
        : {
            mode: continuation.mode,
            nativeContinuity: continuation.native_continuity,
          },
    instruction: row.instruction,
    executionLimitSeconds: row.execution_limit_seconds,
    inputWaitSeconds: row.input_wait_seconds,
    result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type StoredQuestionSchema = {
  question: string;
  header: string;
  options: { label: string; description: string; preview?: string }[];
  multiSelect: boolean;
}[];

const MAX_QUESTION_SCHEMA_BYTES = 32 * 1024;
const MAX_QUESTION_TEXT_BYTES = 4 * 1024;

function boundedQuestionString(
  value: unknown,
  maximumBytes: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

/** Mirrors the bounded AskUserQuestion shape accepted at worker ingress. */
function normalizeQuestionSchema(
  value: unknown,
): StoredQuestionSchema | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) {
    return undefined;
  }
  const normalized: StoredQuestionSchema = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !exactKeys(candidate, ["header", "multiSelect", "options", "question"])
    ) {
      return undefined;
    }
    const sourceOptions = candidate.options;
    if (
      !boundedQuestionString(candidate.question, MAX_QUESTION_TEXT_BYTES) ||
      normalized.some((question) => question.question === candidate.question) ||
      typeof candidate.header !== "string" ||
      candidate.header.length === 0 ||
      candidate.header.length > 12 ||
      !Array.isArray(sourceOptions) ||
      sourceOptions.length < 2 ||
      sourceOptions.length > 4 ||
      typeof candidate.multiSelect !== "boolean"
    ) {
      return undefined;
    }
    const options: StoredQuestionSchema[number]["options"] = [];
    for (const option of sourceOptions) {
      if (!isRecord(option)) return undefined;
      const keys = Object.keys(option).sort();
      if (!(
        ["description", "label"].every((key) => keys.includes(key)) &&
        keys.every((key) => ["description", "label", "preview"].includes(key))
      )) {
        return undefined;
      }
      if (
        !boundedQuestionString(option.label, 128) ||
        options.some((existing) => existing.label === option.label) ||
        !boundedQuestionString(option.description, 1024) ||
        !(
          option.preview === undefined ||
          boundedQuestionString(option.preview, MAX_QUESTION_TEXT_BYTES)
        )
      ) {
        return undefined;
      }
      options.push({
        label: option.label,
        description: option.description,
        ...(option.preview === undefined ? {} : { preview: option.preview }),
      });
    }
    normalized.push({
      question: candidate.question,
      header: candidate.header,
      options,
      multiSelect: candidate.multiSelect,
    });
  }
  return Buffer.byteLength(JSON.stringify(normalized), "utf8") <=
    MAX_QUESTION_SCHEMA_BYTES
    ? normalized
    : undefined;
}

function normalizeQuestionAnswer(
  schema: StoredQuestionSchema,
  value: unknown,
): Record<string, string> | undefined {
  if (!isRecord(value) || Object.keys(value).length !== schema.length)
    return undefined;
  const answer: Record<string, string> = {};
  for (const item of schema) {
    const selection = value[item.question];
    if (!boundedQuestionString(selection, 1024)) return undefined;
    const labels = selection.split(", ");
    if (
      labels.length === 0 ||
      (!item.multiSelect && labels.length !== 1) ||
      new Set(labels).size !== labels.length ||
      labels.some(
        (label) => !item.options.some((option) => option.label === label),
      )
    ) {
      return undefined;
    }
    answer[item.question] = labels.join(", ");
  }
  return answer;
}

function question(row: Record<string, unknown>) {
  const schema = normalizeQuestionSchema(JSON.parse(String(row.schema_json)));
  const toolUseId = row.native_tool_use_id;
  const requestId = row.native_request_id;
  const answerJson = row.answer_json;
  const answer =
    answerJson === null || answerJson === undefined
      ? null
      : typeof answerJson === "string"
        ? normalizeQuestionAnswer(schema ?? [], JSON.parse(answerJson))
        : undefined;
  if (
    schema === undefined ||
    !(
      toolUseId === null ||
      toolUseId === undefined ||
      boundedQuestionIdentifier(toolUseId)
    ) ||
    !(
      requestId === null ||
      requestId === undefined ||
      boundedQuestionIdentifier(requestId)
    ) ||
    (answerJson !== null && answerJson !== undefined && answer === undefined)
  ) {
    throw new Error("stored Question payload is invalid");
  }
  return {
    questionId: String(row.question_id),
    toolUseId: typeof toolUseId === "string" ? toolUseId : null,
    requestId: typeof requestId === "string" ? requestId : null,
    taskId: String(row.task_id),
    executionId: String(row.execution_id),
    reference: {
      executionId: String(row.execution_id),
      generation: String(row.generation),
      daemonEpoch: String(row.daemon_epoch),
      launchProfileId: String(row.launch_profile_id),
      workspaceIdentity: String(row.workspace_identity),
    },
    schema,
    state: typeof row.closed_at === "string" ? "closed" : row.state,
    delivery: row.delivery_state,
    answer: answer ?? null,
    acceptedAt: typeof row.accepted_at === "string" ? row.accepted_at : null,
    expiresAt: String(row.expires_at),
    deliveryAcknowledgedAt:
      typeof row.delivery_acknowledged_at === "string"
        ? row.delivery_acknowledged_at
        : null,
    deliveryUnknownAt:
      typeof row.delivery_unknown_at === "string"
        ? row.delivery_unknown_at
        : null,
    inputExpiryClosedAt:
      typeof row.input_expiry_closed_at === "string"
        ? row.input_expiry_closed_at
        : null,
    closedAt: typeof row.closed_at === "string" ? row.closed_at : null,
    closureReason:
      row.closure_reason === "expired" ||
      row.closure_reason === "canceled" ||
      row.closure_reason === "recovery" ||
      row.closure_reason === "terminal"
        ? row.closure_reason
        : null,
    toolActivityStatus:
      row.tool_activity_status === "idle" ? "idle" : "unknown",
    toolActivityObservedAt:
      typeof row.tool_activity_observed_at === "string"
        ? row.tool_activity_observed_at
        : null,
    createdAt: String(row.created_at),
  };
}

/**
 * The queue has one head per currently unclaimed Workspace. A follow-up is a
 * head only after its immutable predecessor has durably completed.
 */
function eligibleContextHeads(
  scope: string,
  agentIds: readonly string[],
  limit: number,
): Record<string, unknown>[] {
  if (agentIds.length === 0 || !Number.isSafeInteger(limit) || limit < 1) {
    return [];
  }
  const activeExecutions = Number(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM execution_workspace_claims WHERE status IN ('held','quarantined')",
        )
        .get() as { count: number }
    ).count,
  );
  const remainingCapacity =
    (options.activeExecutionCapacity ?? 4) - activeExecutions;
  if (remainingCapacity <= 0) return [];
  return queryEligibleContextHeads(
    scope,
    agentIds,
    Math.min(limit, remainingCapacity),
  );
}

function isEligibleContextHead(
  scope: string,
  agentIds: readonly string[],
  taskId: string,
): boolean {
  return queryEligibleContextHeads(scope, agentIds, 1, taskId).length === 1;
}

function queryEligibleContextHeads(
  scope: string,
  agentIds: readonly string[],
  limit: number,
  taskId?: string,
): Record<string, unknown>[] {
  if (agentIds.length === 0 || !Number.isSafeInteger(limit) || limit < 1) {
    return [];
  }
  const taskFilter = taskId === undefined ? "" : "AND task_id=?";
  return db
    .prepare(
      `WITH eligible AS (
         SELECT t.*, workspace_queue.workspace_id,
                workspace_queue.admission_sequence,
                ROW_NUMBER() OVER (
                  PARTITION BY workspace_queue.workspace_id
                  ORDER BY workspace_queue.admission_sequence
                ) AS workspace_rank
         FROM tasks t
         JOIN task_workspace_queue workspace_queue
           ON workspace_queue.task_id=t.task_id
         WHERE t.state='queued'
           AND t.lifecycle_state IS NULL
           AND (
             t.predecessor_task_id IS NULL OR EXISTS (
               SELECT 1 FROM tasks predecessor
               WHERE predecessor.task_id=t.predecessor_task_id
                 AND COALESCE(predecessor.lifecycle_state, predecessor.state)='completed'
             ) OR EXISTS (
               SELECT 1 FROM context_continuations continuation
               WHERE continuation.context_id=t.context_id
                 AND continuation.target_task_id=t.task_id
                 AND continuation.consumed_by_execution_id IS NULL
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM execution_workspace_claims claim
             WHERE claim.workspace_id=workspace_queue.workspace_id
               AND claim.status IN ('held','quarantined')
           )
       )
       SELECT * FROM eligible
       WHERE workspace_rank=1
         AND scope=?
         AND agent_id IN (${agentIds.map(() => "?").join(",")})
         ${taskFilter}
       ORDER BY admission_sequence
       LIMIT ?`,
    )
    .all(
      scope,
      ...agentIds,
      ...(taskId === undefined ? [] : [taskId]),
      limit,
    ) as Record<string, unknown>[];
}
function execution(row: Record<string, unknown>) {
  const executionId = String(row.execution_id);
  const lifecycleState =
    row.lifecycle_state ??
    (row.state === "recovering"
      ? "recovering"
      : row.stop_reason === null
        ? row.state
        : "stopping");
  const progress = db
    .prepare(
      "SELECT ordinal,payload_json,created_at FROM execution_observations WHERE execution_id=? AND kind='progress' ORDER BY ordinal DESC LIMIT 1",
    )
    .get(executionId) as
    { ordinal: number; payload_json: string; created_at: string } | undefined;
  const candidate = db
    .prepare(
      "SELECT ordinal,final_ordinal FROM execution_observations WHERE execution_id=? AND kind='candidate' LIMIT 1",
    )
    .get(executionId) as
    { ordinal: number; final_ordinal: number | null } | undefined;
  const progressPayload =
    progress === undefined
      ? undefined
      : (JSON.parse(progress.payload_json) as Record<string, unknown>);
  const stopReason =
    row.stop_reason === "completion" || row.stop_reason === "cancellation"
      ? row.stop_reason
      : row.recovery_reason === "runtime_interruption"
        ? "interruption"
        : null;
  return {
    executionId,
    taskId: row.task_id,
    generation: row.generation,
    daemonEpoch: row.daemon_epoch,
    launchProfileId: row.launch_profile_id,
    workspaceId: row.workspace_id,
    state:
      row.recovery_resolution === "interrupted"
        ? "interrupted"
        : lifecycleState === "recovering"
          ? "recovering"
          : lifecycleState === "starting" || lifecycleState === "running"
            ? lifecycleState
            : lifecycleState === "stopping"
              ? "stopping"
              : "prepared",
    workspaceClaim: row.claim_status,
    progress:
      progress === undefined || typeof progressPayload?.summary !== "string"
        ? null
        : {
            ordinal: Number(progress.ordinal),
            summary: progressPayload.summary,
            observedAt: progress.created_at,
          },
    lastObservationOrdinal: Number(row.last_observation_ordinal),
    candidateAvailable: candidate !== undefined,
    finalOrdinal:
      candidate === undefined || candidate.final_ordinal === null
        ? null
        : Number(candidate.final_ordinal),
    stopReason,
    recoveryReason:
      typeof row.recovery_reason === "string" ? row.recovery_reason : null,
    accumulatedExecutionMs: Number(row.accumulated_execution_ms ?? 0),
    accountingPhase:
      row.accounting_phase === "active" || row.accounting_phase === "pure_wait"
        ? row.accounting_phase
        : "stopped",
    accountingPhaseStartedAt:
      typeof row.accounting_phase_started_at === "string"
        ? row.accounting_phase_started_at
        : null,
    revision: row.revision,
  };
}

function validTerminalEvidence(
  row: Record<string, unknown>,
  value: unknown,
): value is {
  platform: "linux-cgroup-v2";
  reference: Record<string, unknown>;
  executionUnitId: string;
  generationSealedAt: string;
  unitEmptyObservedAt: string;
} {
  return (
    isRecord(value) &&
    exactKeys(value, [
      "executionUnitId",
      "generationSealedAt",
      "platform",
      "reference",
      "unitEmptyObservedAt",
    ]) &&
    value.platform === "linux-cgroup-v2" &&
    sameReference(row, value.reference) &&
    typeof value.executionUnitId === "string" &&
    value.executionUnitId.length > 0 &&
    typeof value.generationSealedAt === "string" &&
    Number.isFinite(Date.parse(value.generationSealedAt)) &&
    typeof value.unitEmptyObservedAt === "string" &&
    Number.isFinite(Date.parse(value.unitEmptyObservedAt)) &&
    Date.parse(value.generationSealedAt) <=
      Date.parse(value.unitEmptyObservedAt)
  );
}

function commitTerminal(p: Record<string, unknown>) {
  const stamp = typeof p.now === "string" ? p.now : now();
  const activeElapsedMs = Number(p.activeElapsedMs ?? 0);
  if (
    !Number.isSafeInteger(activeElapsedMs) ||
    activeElapsedMs < 0 ||
    !Number.isFinite(Date.parse(stamp)) ||
    new Date(Date.parse(stamp)).toISOString() !== stamp
  ) {
    throwFailure("operation_conflict", "execution accounting is invalid");
  }
  let releasedControlBytes = 0;
  const committed = db.transaction(() => {
    const evidenceValue = p.evidence;
    if (!isRecord(evidenceValue) || !isRecord(evidenceValue.reference)) {
      throwFailure("operation_conflict", "terminal evidence is invalid");
    }
    const reference = evidenceValue.reference;
    const row = db
      .prepare(
        "SELECT e.*,t.lifecycle_state AS task_lifecycle_state,t.context_id,w.status AS claim_status FROM executions e JOIN tasks t ON t.task_id=e.task_id JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE e.execution_id=? AND e.generation=? AND e.daemon_epoch=? AND e.launch_profile_id=? AND e.workspace_id=?",
      )
      .get(
        reference.executionId,
        reference.generation,
        reference.daemonEpoch,
        reference.launchProfileId,
        reference.workspaceIdentity,
      ) as Record<string, unknown> | undefined;
    if (row === undefined || !validTerminalEvidence(row, evidenceValue)) {
      throwFailure("operation_conflict", "terminal evidence is invalid");
    }
    const existing = db
      .prepare("SELECT * FROM execution_terminals WHERE execution_id=?")
      .get(row.execution_id) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      if (
        existing.generation !== row.generation ||
        existing.daemon_epoch !== row.daemon_epoch ||
        existing.launch_profile_id !== row.launch_profile_id ||
        existing.workspace_identity !== row.workspace_id ||
        existing.execution_unit_id !== evidenceValue.executionUnitId ||
        existing.generation_sealed_at !== evidenceValue.generationSealedAt ||
        existing.unit_empty_observed_at !== evidenceValue.unitEmptyObservedAt
      ) {
        throwFailure("operation_conflict", "terminal evidence conflicts");
      }
      const taskRow = db
        .prepare("SELECT * FROM tasks WHERE task_id=?")
        .get(row.task_id) as Record<string, unknown>;
      const executionRow = db
        .prepare(
          "SELECT e.*,w.status AS claim_status FROM executions e JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE e.execution_id=?",
        )
        .get(row.execution_id) as Record<string, unknown>;
      return {
        task: task(taskRow),
        execution: execution(executionRow),
        replayed: true,
      };
    }
    if (
      row.lifecycle_state !== "stopping" ||
      row.task_lifecycle_state !== "stopping" ||
      (row.claim_status !== "held" && row.claim_status !== "quarantined")
    ) {
      throwFailure(
        "operation_conflict",
        "execution is not ready to terminalize",
      );
    }
    const candidate = db
      .prepare(
        "SELECT payload_json,final_ordinal FROM execution_observations WHERE execution_id=? AND kind='candidate'",
      )
      .get(row.execution_id) as
      { payload_json: string; final_ordinal: number | null } | undefined;
    let terminalState: "completed" | "failed" | "canceled";
    let resultJson: string | null = null;
    let sessionReference: string | null = null;
    let finalOrdinal: number | null = null;
    if (row.stop_reason === "completion") {
      if (
        candidate === undefined ||
        candidate.final_ordinal === null ||
        Number(row.candidate_ordinal) !== candidate.final_ordinal ||
        Number(row.last_observation_ordinal) !== candidate.final_ordinal
      ) {
        throwFailure(
          "operation_conflict",
          "completion candidate is incomplete",
        );
      }
      const payload = JSON.parse(candidate.payload_json) as Record<
        string,
        unknown
      >;
      const outcome = payload.outcome;
      if (
        !isRecord(outcome) ||
        !["completed", "failed", "canceled"].includes(String(outcome.kind)) ||
        typeof outcome.summary !== "string"
      ) {
        throwFailure("operation_conflict", "completion candidate is invalid");
      }
      terminalState = outcome.kind as "completed" | "failed" | "canceled";
      resultJson = JSON.stringify({ summary: outcome.summary });
      const candidateSessionReference = payload.sessionReference;
      if (
        candidateSessionReference !== null &&
        !isSessionReferenceFor(candidateSessionReference, {
          executionId: String(row.execution_id),
          generation: String(row.generation),
          daemonEpoch: String(row.daemon_epoch),
          launchProfileId: String(row.launch_profile_id),
          workspaceIdentity: String(row.workspace_id),
        })
      ) {
        throwFailure(
          "operation_conflict",
          "completion Session reference is invalid",
        );
      }
      // A failed/canceled execution must not publish a resumable Session handle.
      sessionReference =
        terminalState === "completed"
          ? (candidateSessionReference ?? null)
          : null;
      finalOrdinal = candidate.final_ordinal;
    } else if (row.stop_reason === "cancellation") {
      terminalState = "canceled";
    } else if (row.recovery_reason === "runtime_interruption") {
      terminalState = "failed";
    } else {
      throwFailure("operation_conflict", "terminal reason is unavailable");
    }
    db.prepare(
      "INSERT INTO execution_terminals(execution_id,generation,daemon_epoch,launch_profile_id,workspace_identity,platform,execution_unit_id,generation_sealed_at,unit_empty_observed_at,terminal_state,result_json,session_reference,final_ordinal,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      row.execution_id,
      row.generation,
      row.daemon_epoch,
      row.launch_profile_id,
      row.workspace_id,
      evidenceValue.platform,
      evidenceValue.executionUnitId,
      evidenceValue.generationSealedAt,
      evidenceValue.unitEmptyObservedAt,
      terminalState,
      resultJson,
      sessionReference,
      finalOrdinal,
      stamp,
    );
    db.prepare(
      "UPDATE tasks SET lifecycle_state=?,input_state=NULL,reason=NULL,revision=revision+1,updated_at=? WHERE task_id=?",
    ).run(terminalState, stamp, row.task_id);
    if (terminalState !== "completed") {
      const blocker = db
        .prepare(
          "INSERT INTO context_blockers(context_id,predecessor_task_id,state,created_at) VALUES(?,?,?,?) ON CONFLICT(context_id) DO NOTHING",
        )
        .run(row.context_id, row.task_id, terminalState, stamp);
      if (blocker.changes === 1) {
        db.prepare(
          "UPDATE tasks SET state='paused',reason='predecessor_blocked',revision=revision+1,updated_at=? WHERE context_id=? AND state='queued'",
        ).run(stamp, row.context_id);
        db.prepare(
          "UPDATE contexts SET revision=revision+1,pause_reason='predecessor_blocked' WHERE context_id=?",
        ).run(row.context_id);
      }
    }
    db.prepare(
      "UPDATE questions SET state=CASE WHEN state='accepted' THEN 'closed' ELSE state END,closed_at=COALESCE(closed_at,?),closure_reason=COALESCE(closure_reason,'terminal'),delivery_state=CASE WHEN state='accepted' AND delivery_state='pending' THEN 'unknown' ELSE delivery_state END,delivery_unknown_at=CASE WHEN state='accepted' AND delivery_state='pending' THEN ? ELSE delivery_unknown_at END WHERE task_id=? AND closed_at IS NULL AND state IN ('pending','accepted')",
    ).run(stamp, stamp, row.task_id);
    db.prepare(
      "UPDATE executions SET accumulated_execution_ms=accumulated_execution_ms+CASE WHEN accounting_phase='active' THEN ? ELSE 0 END,accounting_phase='stopped',accounting_phase_started_at=NULL WHERE execution_id=?",
    ).run(activeElapsedMs, row.execution_id);
    if (terminalState !== "completed") {
      db.prepare(
        "UPDATE runtime_session_tokens SET state='invalidated',invalidated_at=? WHERE context_id=? AND state='current' AND EXISTS (SELECT 1 FROM context_continuations continuation WHERE continuation.context_id=runtime_session_tokens.context_id AND continuation.mode='preserve' AND continuation.consumed_by_execution_id=?)",
      ).run(stamp, row.context_id, row.execution_id);
      db.prepare(
        "UPDATE contexts SET session_reference=NULL WHERE context_id=? AND EXISTS (SELECT 1 FROM context_continuations continuation WHERE continuation.context_id=contexts.context_id AND continuation.mode='preserve' AND continuation.consumed_by_execution_id=?)",
      ).run(row.context_id, row.execution_id);
    }
    if (sessionReference !== null) {
      const protectedToken = db
        .prepare(
          "SELECT session_reference FROM runtime_session_tokens WHERE source_execution_id=? AND session_reference=? AND context_id=? AND state='candidate'",
        )
        .get(row.execution_id, sessionReference, row.context_id) as
        { session_reference: string } | undefined;
      if (protectedToken !== undefined) {
        db.prepare(
          "UPDATE runtime_session_tokens SET state='invalidated',invalidated_at=? WHERE context_id=? AND state='current'",
        ).run(stamp, row.context_id);
        const activated = db
          .prepare(
            "UPDATE runtime_session_tokens SET state='current',activated_at=? WHERE session_reference=? AND state='candidate'",
          )
          .run(stamp, protectedToken.session_reference);
        if (activated.changes !== 1) {
          throwFailure(
            "operation_conflict",
            "protected Session token conflicts",
          );
        }
      }
      db.prepare(
        "UPDATE contexts SET session_reference=?,revision=revision+1 WHERE context_id=?",
      ).run(sessionReference, row.context_id);
    }
    emit(
      String(row.scope),
      String(row.task_id),
      Number(row.revision) + 1,
      terminalState,
      stamp,
    );
    db.prepare(
      "UPDATE execution_workspace_claims SET status='released',released_at=?,updated_at=? WHERE execution_id=?",
    ).run(stamp, stamp, row.execution_id);
    const reserve = db
      .prepare("SELECT control_bytes FROM task_reservations WHERE task_id=?")
      .get(row.task_id) as { control_bytes: number } | undefined;
    releasedControlBytes = Number(reserve?.control_bytes ?? 0);
    if (releasedControlBytes > 0) {
      db.prepare(
        "UPDATE task_reservations SET control_bytes=0 WHERE task_id=?",
      ).run(row.task_id);
      changeCapacity("reserved_control_bytes", -releasedControlBytes);
    }
    changeCapacity("active_global", -1);
    changeCapacity(workspaceCapacityKey(String(row.workspace_id)), -1);
    maybeFail();
    waitAtTestCommitBarrier();
    const taskRow = db
      .prepare("SELECT * FROM tasks WHERE task_id=?")
      .get(row.task_id) as Record<string, unknown>;
    const executionRow = db
      .prepare(
        "SELECT e.*,w.status AS claim_status FROM executions e JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE e.execution_id=?",
      )
      .get(row.execution_id) as Record<string, unknown>;
    return {
      task: task(taskRow),
      execution: execution(executionRow),
      replayed: false,
    };
  })();
  if (releasedControlBytes > 0) {
    releasePhysicalControlReserve(releasedControlBytes);
  }
  return committed;
}

const MAX_OBSERVATION_ORDINAL = 1024;
const MAX_PROGRESS_BYTES = 1024;
const MAX_CANDIDATE_BYTES = 64 * 1024;
const MAX_OBSERVATION_BYTES = 1024 * 1024;

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function sameReference(row: Record<string, unknown>, value: unknown): boolean {
  return (
    isRecord(value) &&
    exactKeys(value, [
      "daemonEpoch",
      "executionId",
      "generation",
      "launchProfileId",
      "workspaceIdentity",
    ]) &&
    value.executionId === row.execution_id &&
    value.generation === row.generation &&
    value.daemonEpoch === row.daemon_epoch &&
    value.launchProfileId === row.launch_profile_id &&
    value.workspaceIdentity === row.workspace_id
  );
}

type NormalizedObservation =
  | {
      kind: "progress";
      ordinal: number;
      payloadJson: string;
      payloadBytes: number;
      finalOrdinal: null;
    }
  | {
      kind: "candidate";
      ordinal: number;
      payloadJson: string;
      payloadBytes: number;
      finalOrdinal: number;
      protectedSessionToken?: string;
    };

function normalizeObservation(
  row: Record<string, unknown>,
  value: unknown,
): NormalizedObservation | undefined {
  if (!isRecord(value) || !sameReference(row, value.reference)) {
    return undefined;
  }
  const ordinal = value.ordinal;
  if (
    typeof ordinal !== "number" ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 1 ||
    ordinal > MAX_OBSERVATION_ORDINAL
  ) {
    return undefined;
  }
  if (
    value.kind === "progress" &&
    exactKeys(value, ["kind", "ordinal", "reference", "summary"]) &&
    typeof value.summary === "string"
  ) {
    const payloadJson = JSON.stringify({ summary: value.summary });
    const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
    if (payloadBytes > MAX_PROGRESS_BYTES) return undefined;
    return {
      kind: "progress",
      ordinal,
      payloadJson,
      payloadBytes,
      finalOrdinal: null,
    };
  }
  if (
    value.kind === "candidate" &&
    ["finalOrdinal", "kind", "ordinal", "outcome", "reference"].every(
      (key) => key in value,
    ) &&
    Object.keys(value).every((key) =>
      [
        "finalOrdinal",
        "kind",
        "ordinal",
        "outcome",
        "reference",
        "sessionReference",
        "protectedSessionToken",
      ].includes(key),
    ) &&
    typeof value.finalOrdinal === "number" &&
    Number.isSafeInteger(value.finalOrdinal) &&
    value.finalOrdinal === ordinal &&
    isRecord(value.outcome) &&
    exactKeys(value.outcome, ["kind", "summary"]) &&
    ["completed", "failed", "canceled"].includes(String(value.outcome.kind)) &&
    typeof value.outcome.summary === "string" &&
    Buffer.byteLength(value.outcome.summary, "utf8") <= MAX_CANDIDATE_BYTES &&
    (value.sessionReference === undefined ||
      value.sessionReference === null ||
      isSessionReferenceFor(value.sessionReference, {
        executionId: String(row.execution_id),
        generation: String(row.generation),
        daemonEpoch: String(row.daemon_epoch),
        launchProfileId: String(row.launch_profile_id),
        workspaceIdentity: String(row.workspace_id),
      })) &&
    (value.protectedSessionToken === undefined ||
      (value.outcome.kind === "completed" &&
        typeof value.sessionReference === "string" &&
        isProtectedClaudeSessionToken(value.protectedSessionToken) &&
        value.sessionReference ===
          sessionReferenceFor(
            {
              executionId: String(row.execution_id),
              generation: String(row.generation),
              daemonEpoch: String(row.daemon_epoch),
              launchProfileId: String(row.launch_profile_id),
              workspaceIdentity: String(row.workspace_id),
            },
            value.protectedSessionToken,
          )))
  ) {
    const payloadJson = JSON.stringify({
      outcome: { kind: value.outcome.kind, summary: value.outcome.summary },
      sessionReference: value.sessionReference ?? null,
    });
    const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
    if (payloadBytes > MAX_CANDIDATE_BYTES) return undefined;
    return {
      kind: "candidate",
      ordinal,
      payloadJson,
      payloadBytes,
      finalOrdinal: ordinal,
      ...(value.protectedSessionToken === undefined
        ? {}
        : { protectedSessionToken: value.protectedSessionToken }),
    };
  }
  return undefined;
}

function quarantineObservation(
  executionId: unknown,
  reason: string,
  stamp: string,
): void {
  db.prepare(
    "UPDATE executions SET state=CASE WHEN stop_reason IS NULL THEN 'recovering' ELSE state END,recovery_reason=?,recovery_started_at=?,revision=revision+1,updated_at=? WHERE execution_id=?",
  ).run(reason, stamp, stamp, executionId);
  db.prepare(
    "UPDATE execution_workspace_claims SET status='quarantined',updated_at=? WHERE execution_id=?",
  ).run(stamp, executionId);
}

function commitExecutionObservation(p: Record<string, unknown>) {
  const scope = String(p.accessScopeId);
  const taskId = String(p.taskId);
  const stamp = typeof p.now === "string" ? p.now : now();
  const internalRuntime = p.internalRuntime === true;
  checkpointWal();
  const transaction = <T>(operation: () => T): T =>
    internalRuntime
      ? db.transaction(operation)()
      : registryFencedTransaction(p.expectedRegistryRevision, operation);
  const outcome = transaction(() => {
    const agentIds = authorizedAgentIds(p.allowedAgentIds);
    const row = internalRuntime
      ? (db
          .prepare(
            "SELECT e.*,t.context_id,b.payload_json AS binding_payload,w.status AS claim_status FROM executions e JOIN tasks t ON t.task_id=e.task_id JOIN binding_snapshots b ON b.binding_snapshot_id=e.binding_snapshot_id LEFT JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE e.task_id=?",
          )
          .get(taskId) as Record<string, unknown> | undefined)
      : agentIds.length === 0
        ? undefined
        : (db
            .prepare(
              `SELECT e.*,t.context_id,b.payload_json AS binding_payload,w.status AS claim_status FROM executions e JOIN tasks t ON t.task_id=e.task_id JOIN binding_snapshots b ON b.binding_snapshot_id=e.binding_snapshot_id LEFT JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE t.scope=? AND e.task_id=? AND t.agent_id IN (${agentIds.map(() => "?").join(",")})`,
            )
            .get(scope, taskId, ...agentIds) as
            Record<string, unknown> | undefined);
    if (row === undefined) return { failure: "not_found" as const };

    const observation = normalizeObservation(row, p.observation);
    if (observation === undefined) {
      quarantineObservation(row.execution_id, "invalid_observation", stamp);
      return { failure: "operation_conflict" as const };
    }

    const fingerprint = createHash("sha256")
      .update(observation.kind)
      .update("\0")
      .update(observation.payloadJson)
      .update("\0")
      .update(String(observation.finalOrdinal ?? ""))
      .digest("hex");
    const existing = db
      .prepare(
        "SELECT kind,payload_json,payload_fingerprint,final_ordinal FROM execution_observations WHERE execution_id=? AND ordinal=?",
      )
      .get(row.execution_id, observation.ordinal) as
      Record<string, unknown> | undefined;
    if (existing !== undefined) {
      if (
        existing.kind === observation.kind &&
        existing.payload_json === observation.payloadJson &&
        existing.payload_fingerprint === fingerprint &&
        (existing.final_ordinal === null
          ? observation.finalOrdinal === null
          : Number(existing.final_ordinal) === observation.finalOrdinal)
      ) {
        return { replayed: true as const };
      }
      quarantineObservation(row.execution_id, "conflicting_observation", stamp);
      return { failure: "operation_conflict" as const };
    }
    if (row.state === "recovering" || row.claim_status === "quarantined") {
      return { failure: "operation_conflict" as const };
    }
    const lastOrdinal = Number(row.last_observation_ordinal);
    const observationBytes = Number(row.observation_bytes);
    if (
      observation.ordinal !== lastOrdinal + 1 ||
      observationBytes + observation.payloadBytes > MAX_OBSERVATION_BYTES ||
      (row.candidate_ordinal !== null && row.candidate_ordinal !== undefined)
    ) {
      quarantineObservation(
        row.execution_id,
        "invalid_observation_sequence",
        stamp,
      );
      return { failure: "operation_conflict" as const };
    }
    requirePhysicalHeadroom(
      physicalAdmissionBytes,
      observation.payloadBytes + 8 * pageSize,
    );

    db.prepare(
      "INSERT INTO execution_observations(execution_id,generation,daemon_epoch,launch_profile_id,workspace_identity,ordinal,kind,payload_json,payload_fingerprint,payload_bytes,final_ordinal,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      row.execution_id,
      row.generation,
      row.daemon_epoch,
      row.launch_profile_id,
      row.workspace_id,
      observation.ordinal,
      observation.kind,
      observation.payloadJson,
      fingerprint,
      observation.payloadBytes,
      observation.finalOrdinal,
      stamp,
    );
    if (
      observation.kind === "candidate" &&
      observation.protectedSessionToken !== undefined
    ) {
      const binding = continuationBinding(row);
      if (binding === undefined || continuationEncryptionKey === undefined) {
        quarantineObservation(
          row.execution_id,
          "protected_session_unavailable",
          stamp,
        );
        return { failure: "operation_conflict" as const };
      }
      const sessionReference = JSON.parse(observation.payloadJson) as {
        sessionReference: string;
      };
      const protectedRow = {
        ...row,
        session_reference: sessionReference.sessionReference,
        runtime_driver: binding.runtimeDriver,
        runtime_version: binding.runtimeVersion,
      };
      const encrypted = encryptContinuationToken(
        observation.protectedSessionToken,
        protectedRow,
      );
      db.prepare(
        "INSERT INTO runtime_session_tokens(session_reference,source_execution_id,context_id,binding_snapshot_id,runtime_driver,runtime_version,workspace_identity,ciphertext,nonce,auth_tag,key_id,state,activated_at,invalidated_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'candidate',NULL,NULL,?)",
      ).run(
        protectedRow.session_reference,
        row.execution_id,
        row.context_id,
        row.binding_snapshot_id,
        binding.runtimeDriver,
        binding.runtimeVersion,
        row.workspace_id,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authTag,
        encrypted.keyId,
        stamp,
      );
    }
    if (observation.kind === "candidate") {
      db.prepare(
        "UPDATE executions SET lifecycle_state=CASE WHEN lifecycle_state IS NULL THEN NULL ELSE 'stopping' END,last_observation_ordinal=?,observation_bytes=observation_bytes+?,candidate_ordinal=?,stop_reason=COALESCE(stop_reason,'completion'),stop_reason_committed_at=COALESCE(stop_reason_committed_at,?),revision=revision+1,updated_at=? WHERE execution_id=?",
      ).run(
        observation.ordinal,
        observation.payloadBytes,
        observation.ordinal,
        stamp,
        stamp,
        row.execution_id,
      );
      db.prepare(
        "UPDATE tasks SET lifecycle_state=CASE WHEN lifecycle_state IS NULL THEN NULL ELSE 'stopping' END,reason=CASE WHEN lifecycle_state IS NULL THEN reason ELSE 'execution_stopping' END,revision=revision+1,updated_at=? WHERE task_id=?",
      ).run(stamp, row.task_id);
    } else {
      db.prepare(
        "UPDATE executions SET last_observation_ordinal=?,observation_bytes=observation_bytes+?,revision=revision+1,updated_at=? WHERE execution_id=?",
      ).run(
        observation.ordinal,
        observation.payloadBytes,
        stamp,
        row.execution_id,
      );
    }
    requirePhysicalHeadroom(physicalAdmissionBytes);
    maybeFail();
    return { replayed: false as const };
  });
  if ("failure" in outcome) {
    throwFailure(
      outcome.failure,
      outcome.failure === "not_found"
        ? "execution was not found"
        : "execution observation was rejected",
      taskId,
    );
  }
  const row = db
    .prepare(
      "SELECT e.*,w.status AS claim_status FROM executions e LEFT JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE e.task_id=?",
    )
    .get(taskId) as Record<string, unknown>;
  return { execution: execution(row), replayed: outcome.replayed };
}
function commitRuntimeObservation(p: Record<string, unknown>) {
  return commitExecutionObservation({ ...p, internalRuntime: true });
}

function boundedQuestionIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function questionForTask(taskId: string): Record<string, unknown> | undefined {
  return db
    .prepare(
      "SELECT * FROM questions WHERE task_id=? ORDER BY created_at DESC LIMIT 1",
    )
    .get(taskId) as Record<string, unknown> | undefined;
}

/** Trusted worker ingress; persistence precedes every caller-visible read. */
function persistQuestionObservation(p: Record<string, unknown>) {
  const reference = p.reference;
  const questionId = p.questionId;
  const toolUseId = p.toolUseId;
  const requestId = p.requestId;
  const ordinal = Number(p.ordinal);
  const activeElapsedMs = Number(p.activeElapsedMs);
  const stamp = typeof p.now === "string" ? p.now : now();
  const expiresAt = typeof p.expiresAt === "string" ? p.expiresAt : "";
  const schema = normalizeQuestionSchema(p.schema);
  if (
    !isRecord(reference) ||
    !boundedQuestionIdentifier(questionId) ||
    !boundedQuestionIdentifier(toolUseId) ||
    !boundedQuestionIdentifier(requestId) ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 1 ||
    p.toolActivity !== "none" ||
    !Number.isSafeInteger(activeElapsedMs) ||
    activeElapsedMs < 0 ||
    schema === undefined ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= Date.parse(stamp)
  ) {
    throwFailure("operation_conflict", "Question observation is invalid");
  }
  const schemaJson = JSON.stringify(schema);
  checkpointWal();
  return db.transaction(() => {
    const row = db
      .prepare(
        "SELECT e.*,t.scope,t.lifecycle_state AS task_lifecycle_state,t.input_state AS task_input_state,w.status AS claim_status FROM executions e JOIN tasks t ON t.task_id=e.task_id JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE e.execution_id=? AND e.generation=? AND e.daemon_epoch=? AND e.launch_profile_id=? AND e.workspace_id=?",
      )
      .get(
        reference.executionId,
        reference.generation,
        reference.daemonEpoch,
        reference.launchProfileId,
        reference.workspaceIdentity,
      ) as Record<string, unknown> | undefined;
    if (row === undefined) {
      throwFailure(
        "operation_conflict",
        "Question does not bind the current execution",
      );
    }
    if (!sameReference(row, reference)) {
      throwFailure(
        "operation_conflict",
        "Question execution reference is invalid",
      );
    }
    if (
      row.lifecycle_state !== "running" ||
      row.task_lifecycle_state !== "running"
    ) {
      throwFailure(
        "operation_conflict",
        "Question does not bind a running execution",
      );
    }
    if (row.claim_status !== "held") {
      throwFailure(
        "operation_conflict",
        "Question execution claim is unavailable",
      );
    }
    const lastOrdinal = Number(row.last_observation_ordinal);
    const existing = db
      .prepare("SELECT * FROM questions WHERE question_id=?")
      .get(questionId) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      if (
        existing.execution_id === row.execution_id &&
        existing.generation === row.generation &&
        existing.daemon_epoch === row.daemon_epoch &&
        existing.launch_profile_id === row.launch_profile_id &&
        existing.workspace_identity === row.workspace_id &&
        existing.native_tool_use_id === toolUseId &&
        existing.native_request_id === requestId &&
        existing.schema_json === schemaJson &&
        existing.expires_at === expiresAt &&
        lastOrdinal === ordinal
      ) {
        return question(existing);
      }
      throwFailure("operation_conflict", "Question observation conflicts");
    }
    if (row.accounting_phase !== "active") {
      throwFailure(
        "operation_conflict",
        "Question does not bind active execution accounting",
      );
    }
    if (lastOrdinal + 1 !== ordinal) {
      throwFailure(
        "operation_conflict",
        "Question observation sequence is invalid",
      );
    }
    if (
      db
        .prepare(
          "SELECT 1 FROM questions WHERE execution_id=? AND closed_at IS NULL AND state IN ('pending','accepted') AND delivery_state='pending'",
        )
        .get(row.execution_id) !== undefined
    ) {
      throwFailure(
        "operation_conflict",
        "execution already has a pending Question",
      );
    }
    requirePhysicalHeadroom(
      physicalAdmissionBytes,
      Buffer.byteLength(schemaJson, "utf8") + 8 * pageSize,
    );
    db.prepare(
      "INSERT INTO questions(question_id,task_id,execution_id,generation,daemon_epoch,launch_profile_id,workspace_identity,native_tool_use_id,native_request_id,schema_json,state,delivery_state,expires_at,tool_activity_status,tool_activity_observed_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?, 'pending','pending',?,'idle',?,?)",
    ).run(
      questionId,
      row.task_id,
      row.execution_id,
      row.generation,
      row.daemon_epoch,
      row.launch_profile_id,
      row.workspace_id,
      toolUseId,
      requestId,
      schemaJson,
      expiresAt,
      stamp,
      stamp,
    );
    const observed = db
      .prepare(
        "UPDATE executions SET last_observation_ordinal=?,accumulated_execution_ms=accumulated_execution_ms+?,accounting_phase='pure_wait',accounting_phase_started_at=?,updated_at=? WHERE execution_id=? AND last_observation_ordinal=? AND accounting_phase='active'",
      )
      .run(
        ordinal,
        activeElapsedMs,
        stamp,
        stamp,
        row.execution_id,
        lastOrdinal,
      );
    if (observed.changes !== 1) {
      throwFailure(
        "operation_conflict",
        "Question observation lost its sequence",
      );
    }
    db.prepare(
      "UPDATE tasks SET input_state='awaiting_input',reason='awaiting_input',revision=revision+1,updated_at=? WHERE task_id=? AND lifecycle_state='running' AND input_state IS NULL",
    ).run(stamp, row.task_id);
    const inserted = db
      .prepare("SELECT * FROM questions WHERE question_id=?")
      .get(questionId) as Record<string, unknown>;
    requirePhysicalHeadroom(physicalAdmissionBytes);
    return question(inserted);
  })();
}

/** Caller reply: a first valid answer is durable but remains delivery-pending. */
function replyToQuestion(p: Record<string, unknown>) {
  const scope = String(p.accessScopeId);
  const operationId = String(p.operationId);
  const fingerprint = String(p.fingerprint);
  const principalId = String(p.principalId);
  const taskId = String(p.taskId);
  const questionId = String(p.questionId);
  const stamp = typeof p.now === "string" ? p.now : now();
  const authorizedAgents = authorizedAgentIds(p.allowedAgentIds);
  const replay = registryFencedRead(p.expectedRegistryRevision, () => {
    const old = receipt(
      scope,
      operationId,
      "reply",
      questionId,
      fingerprint,
      authorizedAgents,
    );
    if (old === undefined) return undefined;
    const questionRow = db
      .prepare(
        "SELECT q.*,t.agent_id FROM questions q JOIN tasks t ON t.task_id=q.task_id WHERE q.question_id=? AND q.task_id=? AND t.scope=?",
      )
      .get(questionId, taskId, scope) as Record<string, unknown> | undefined;
    if (
      questionRow === undefined ||
      !allowed(questionRow.agent_id, p.allowedAgentIds)
    ) {
      throwFailure("not_found", "Question was not found");
    }
    const taskRow = db
      .prepare("SELECT * FROM tasks WHERE task_id=?")
      .get(questionRow.task_id) as Record<string, unknown>;
    const executionRow = db
      .prepare(
        "SELECT e.*,w.status AS claim_status FROM executions e JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE e.execution_id=?",
      )
      .get(questionRow.execution_id) as Record<string, unknown>;
    return {
      execution: execution(executionRow),
      question: question(questionRow),
      task: task(taskRow),
      replayed: true,
    };
  });
  if (replay !== undefined) return replay;
  checkpointWal();
  let releasedControlBytes = 0;
  try {
    const result = registryFencedTransaction(p.expectedRegistryRevision, () => {
      const agentIds = authorizedAgents;
      const row =
        agentIds.length === 0
          ? undefined
          : (db
              .prepare(
                `SELECT q.*,t.scope,t.agent_id,t.lifecycle_state AS task_lifecycle_state,t.input_state AS task_input_state,e.lifecycle_state AS execution_lifecycle_state,w.status AS claim_status
               FROM questions q JOIN tasks t ON t.task_id=q.task_id JOIN executions e ON e.execution_id=q.execution_id JOIN execution_workspace_claims w ON w.execution_id=e.execution_id
               WHERE q.question_id=? AND q.task_id=? AND t.scope=? AND t.agent_id IN (${agentIds.map(() => "?").join(",")})`,
              )
              .get(questionId, taskId, scope, ...agentIds) as
              Record<string, unknown> | undefined);
      if (row === undefined)
        throwFailure("not_found", "Question was not found");
      if (
        row.closed_at === null &&
        row.state === "pending" &&
        Date.parse(String(row.expires_at)) <= Date.parse(stamp)
      ) {
        db.prepare(
          "UPDATE questions SET closed_at=?,closure_reason='expired' WHERE question_id=? AND state='pending' AND closed_at IS NULL",
        ).run(stamp, questionId);
        return undefined;
      }
      const schema = normalizeQuestionSchema(
        JSON.parse(String(row.schema_json)),
      );
      const answer =
        schema === undefined
          ? undefined
          : normalizeQuestionAnswer(schema, p.answer);
      if (answer === undefined) {
        throwFailure(
          "operation_conflict",
          "Question answer is invalid",
          String(row.task_id),
        );
      }
      const answerJson = JSON.stringify(answer);
      const answerFingerprint = createHash("sha256")
        .update(answerJson)
        .digest("hex");
      if (
        row.state === "accepted" &&
        row.delivery_state === "pending" &&
        row.answer_fingerprint === answerFingerprint
      ) {
        throwFailure(
          "operation_conflict",
          "Question answer was already accepted",
          String(row.task_id),
        );
      }
      if (
        row.state !== "pending" ||
        row.closed_at !== null ||
        row.delivery_state !== "pending" ||
        row.task_lifecycle_state !== "running" ||
        row.task_input_state !== "awaiting_input" ||
        row.execution_lifecycle_state !== "running" ||
        row.claim_status !== "held"
      ) {
        throwFailure(
          "operation_conflict",
          "Question cannot receive an answer",
          String(row.task_id),
        );
      }
      const reserve = db
        .prepare("SELECT * FROM task_reservations WHERE task_id=?")
        .get(row.task_id) as Record<string, unknown> | undefined;
      const replyReserveBytes = Math.floor(taskControlReserveBytes / 2);
      if (
        reserve === undefined ||
        Number(reserve.control_receipts) < 2 ||
        Number(reserve.control_bytes) < replyReserveBytes
      ) {
        throwFailure("storage_capacity", "task control reserve is exhausted");
      }
      releasedControlBytes = replyReserveBytes;
      releasePhysicalControlReserve(releasedControlBytes);
      requirePhysicalHeadroom(
        physicalCapacityBytes,
        Buffer.byteLength(answerJson, "utf8") + 4 * pageSize,
      );
      const accepted = db
        .prepare(
          "UPDATE questions SET state='accepted',answer_fingerprint=?,answer_json=?,accepted_actor_principal_id=?,accepted_at=?,input_expiry_closed_at=? WHERE question_id=? AND state='pending' AND delivery_state='pending' AND closed_at IS NULL",
        )
        .run(
          answerFingerprint,
          answerJson,
          principalId,
          stamp,
          stamp,
          questionId,
        );
      if (accepted.changes !== 1) {
        throwFailure(
          "operation_conflict",
          "Question answer lost its first-answer race",
          String(row.task_id),
        );
      }
      db.prepare(
        "UPDATE executions SET accounting_phase='active',accounting_phase_started_at=?,updated_at=? WHERE execution_id=? AND accounting_phase='pure_wait'",
      ).run(stamp, stamp, row.execution_id);
      db.prepare(
        "INSERT INTO operation_receipts(scope,operation_id,operation_type,target_id,fingerprint,actor_principal_id,result_json,created_at) VALUES(?,?, 'reply',?,?,?,?,?)",
      ).run(
        scope,
        operationId,
        questionId,
        fingerprint,
        principalId,
        JSON.stringify({ taskId: row.task_id, questionId, answerFingerprint }),
        stamp,
      );
      db.prepare(
        "UPDATE task_reservations SET control_receipts=control_receipts-1,control_bytes=control_bytes-? WHERE task_id=?",
      ).run(releasedControlBytes, row.task_id);
      changeCapacity("reserved_control_bytes", -releasedControlBytes);
      const questionRow = db
        .prepare("SELECT * FROM questions WHERE question_id=?")
        .get(questionId) as Record<string, unknown>;
      const taskRow = db
        .prepare("SELECT * FROM tasks WHERE task_id=?")
        .get(row.task_id) as Record<string, unknown>;
      const executionRow = db
        .prepare(
          "SELECT e.*,w.status AS claim_status FROM executions e JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE e.execution_id=?",
        )
        .get(row.execution_id) as Record<string, unknown>;
      requirePhysicalHeadroom(physicalCapacityBytes);
      return {
        execution: execution(executionRow),
        question: question(questionRow),
        task: task(taskRow),
        replayed: false,
      };
    });
    if (result === undefined) {
      throwFailure(
        "operation_conflict",
        "Question cannot receive an answer",
        taskId,
      );
    }
    return result;
  } catch (error) {
    if (releasedControlBytes > 0) {
      try {
        reconcilePhysicalControlReserve();
      } catch {
        throwFailure(
          "storage_unavailable",
          "physical control reserve reconciliation failed",
        );
      }
    }
    throw error;
  }
}

/**
 * Trusted worker delivery lookup. A pending Question remains waitable; an
 * accepted answer is returned only while its bound execution still holds the
 * Workspace claim. Closed, canceled, expired, or mismatched Questions are
 * deliberately indistinguishable from an unavailable delivery.
 */
function getQuestionForDelivery(p: Record<string, unknown>) {
  const reference = p.reference;
  const questionId = p.questionId;
  const toolUseId = p.toolUseId;
  const requestId = p.requestId;
  const stamp = typeof p.now === "string" ? p.now : now();
  if (
    !isRecord(reference) ||
    !boundedQuestionIdentifier(questionId) ||
    !boundedQuestionIdentifier(toolUseId) ||
    !boundedQuestionIdentifier(requestId) ||
    !Number.isFinite(Date.parse(stamp))
  ) {
    throwFailure("operation_conflict", "Question delivery is invalid");
  }
  return db.transaction(() => {
    const row = db
      .prepare(
        "SELECT q.*,e.workspace_id FROM questions q JOIN tasks t ON t.task_id=q.task_id JOIN executions e ON e.execution_id=q.execution_id JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE q.question_id=? AND q.native_tool_use_id=? AND q.native_request_id=? AND e.execution_id=? AND e.generation=? AND e.daemon_epoch=? AND e.launch_profile_id=? AND e.workspace_id=? AND q.closed_at IS NULL AND q.state IN ('pending','accepted') AND q.delivery_state='pending' AND t.lifecycle_state='running' AND t.input_state='awaiting_input' AND e.lifecycle_state='running' AND w.status='held'",
      )
      .get(
        questionId,
        toolUseId,
        requestId,
        reference.executionId,
        reference.generation,
        reference.daemonEpoch,
        reference.launchProfileId,
        reference.workspaceIdentity,
      ) as Record<string, unknown> | undefined;
    if (row === undefined || !sameReference(row, reference)) return undefined;
    if (
      row.state === "pending" &&
      Date.parse(String(row.expires_at)) <= Date.parse(stamp)
    ) {
      db.prepare(
        "UPDATE questions SET closed_at=?,closure_reason='expired' WHERE question_id=? AND state='pending' AND closed_at IS NULL",
      ).run(stamp, questionId);
      const expired = db
        .prepare("SELECT * FROM questions WHERE question_id=?")
        .get(questionId) as Record<string, unknown>;
      return question(expired);
    }
    return question(row);
  })();
}

/** A lost worker makes an accepted answer non-redeliverable without guessing success. */
function markQuestionDeliveryUnknown(p: Record<string, unknown>) {
  const reference = p.reference;
  const questionId = p.questionId;
  const toolUseId = p.toolUseId;
  const requestId = p.requestId;
  const stamp = typeof p.now === "string" ? p.now : now();
  if (
    !isRecord(reference) ||
    !boundedQuestionIdentifier(questionId) ||
    !boundedQuestionIdentifier(toolUseId) ||
    !boundedQuestionIdentifier(requestId)
  ) {
    throwFailure("operation_conflict", "Question delivery is invalid");
  }
  const changed = db
    .prepare(
      "UPDATE questions SET delivery_state='unknown',delivery_unknown_at=? WHERE question_id=? AND native_tool_use_id=? AND native_request_id=? AND execution_id=? AND generation=? AND daemon_epoch=? AND launch_profile_id=? AND workspace_identity=? AND state='accepted' AND delivery_state='pending'",
    )
    .run(
      stamp,
      questionId,
      toolUseId,
      requestId,
      reference.executionId,
      reference.generation,
      reference.daemonEpoch,
      reference.launchProfileId,
      reference.workspaceIdentity,
    );
  if (changed.changes === 0) return;
}

/** Trusted worker acknowledgement is the only transition out of awaiting_input. */
function acknowledgeQuestionDelivery(p: Record<string, unknown>) {
  const reference = p.reference;
  const questionId = p.questionId;
  const toolUseId = p.toolUseId;
  const requestId = p.requestId;
  const stamp = typeof p.now === "string" ? p.now : now();
  if (
    !isRecord(reference) ||
    !boundedQuestionIdentifier(questionId) ||
    !boundedQuestionIdentifier(toolUseId) ||
    !boundedQuestionIdentifier(requestId)
  ) {
    throwFailure("operation_conflict", "Question acknowledgement is invalid");
  }
  return db.transaction(() => {
    const row = db
      .prepare(
        "SELECT q.*,e.workspace_id,t.lifecycle_state AS task_lifecycle_state,t.input_state AS task_input_state,e.lifecycle_state AS execution_lifecycle_state,w.status AS claim_status FROM questions q JOIN tasks t ON t.task_id=q.task_id JOIN executions e ON e.execution_id=q.execution_id JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE q.question_id=? AND q.native_tool_use_id=? AND q.native_request_id=? AND e.execution_id=? AND e.generation=? AND e.daemon_epoch=? AND e.launch_profile_id=? AND e.workspace_id=?",
      )
      .get(
        questionId,
        toolUseId,
        requestId,
        reference.executionId,
        reference.generation,
        reference.daemonEpoch,
        reference.launchProfileId,
        reference.workspaceIdentity,
      ) as Record<string, unknown> | undefined;
    if (
      row === undefined ||
      !sameReference(row, reference) ||
      row.state !== "accepted" ||
      row.delivery_state !== "pending" ||
      row.task_lifecycle_state !== "running" ||
      row.task_input_state !== "awaiting_input" ||
      row.execution_lifecycle_state !== "running" ||
      row.claim_status !== "held"
    ) {
      throwFailure("operation_conflict", "Question acknowledgement is invalid");
    }
    const acknowledged = db
      .prepare(
        "UPDATE questions SET state='closed',delivery_state='acknowledged',delivery_acknowledged_at=? WHERE question_id=? AND state='accepted' AND delivery_state='pending'",
      )
      .run(stamp, questionId);
    if (acknowledged.changes !== 1) {
      throwFailure("operation_conflict", "Question acknowledgement conflicts");
    }
    db.prepare(
      "UPDATE tasks SET input_state=NULL,reason=NULL,revision=revision+1,updated_at=? WHERE task_id=? AND input_state='awaiting_input' AND lifecycle_state='running'",
    ).run(stamp, row.task_id);
    const questionRow = db
      .prepare("SELECT * FROM questions WHERE question_id=?")
      .get(questionId) as Record<string, unknown>;
    const taskRow = db
      .prepare("SELECT * FROM tasks WHERE task_id=?")
      .get(row.task_id) as Record<string, unknown>;
    return { question: question(questionRow), task: task(taskRow) };
  })();
}
function claimAndPrepare(p: Record<string, unknown>) {
  const scope = String(p.accessScopeId);
  const taskId = String(p.taskId);
  const executionId = String(p.executionId);
  const generation = String(p.generation);
  const daemonEpoch = String(p.daemonEpoch);
  const dispatchIntent = p.dispatchIntent === true;
  const binding = p.binding;
  if (
    !isRecord(binding) ||
    typeof binding.bindingSnapshotId !== "string" ||
    typeof binding.agentId !== "string" ||
    !isRecord(binding.workspaceIdentity) ||
    typeof binding.workspaceIdentity.filesystemIdentity !== "string" ||
    typeof binding.configurationRevision !== "string" ||
    typeof binding.runtimeDriver !== "string" ||
    typeof binding.runtimeVersion !== "string" ||
    typeof binding.launchProfileId !== "string" ||
    !isRecord(binding.policy) ||
    !Number.isSafeInteger(binding.policy.maximumExecutionLimitSeconds) ||
    Number(binding.policy.maximumExecutionLimitSeconds) < 1 ||
    !Number.isSafeInteger(binding.policy.maximumInputWaitSeconds) ||
    Number(binding.policy.maximumInputWaitSeconds) < 1
  ) {
    throw new Error("invalid internal dispatch binding");
  }
  const bindingPolicy = binding.policy;
  const workspaceId = binding.workspaceIdentity.filesystemIdentity;
  const stamp = now();
  try {
    return registryFencedTransaction(
      p.expectedRegistryRevision,
      () => {
        const row = db
          .prepare(
            "SELECT t.task_id,t.context_id,t.state,t.lifecycle_state,t.agent_id,t.execution_limit_seconds,t.input_wait_seconds,c.binding_snapshot_id AS context_binding_snapshot_id,b.workspace_id AS context_workspace_id,b.payload_json AS context_binding_payload FROM tasks t JOIN contexts c ON c.context_id=t.context_id JOIN binding_snapshots b ON b.binding_snapshot_id=c.binding_snapshot_id WHERE t.scope=? AND t.task_id=?",
          )
          .get(scope, taskId) as Record<string, unknown> | undefined;
        if (
          row?.lifecycle_state !== null &&
          row?.lifecycle_state !== undefined
        ) {
          throwFailure(
            "operation_conflict",
            "task already has an execution lifecycle",
            taskId,
          );
        }
        if (
          !row ||
          !allowed(row.agent_id, p.allowedAgentIds) ||
          (row.state !== "queued" && row.state !== "paused")
        ) {
          throwFailure(
            "invalid_state",
            "task cannot prepare an execution",
            taskId,
          );
        }
        let contextBinding: Record<string, unknown> | undefined;
        try {
          const value: unknown = JSON.parse(
            String(row.context_binding_payload),
          );
          contextBinding = isRecord(value) ? value : undefined;
        } catch {
          contextBinding = undefined;
        }
        const contextWorkspace = contextBinding?.workspaceIdentity;
        const contextPolicy = contextBinding?.policy;
        if (
          contextBinding === undefined ||
          !isRecord(contextWorkspace) ||
          !isRecord(contextPolicy) ||
          row.context_workspace_id !== workspaceId ||
          contextWorkspace.filesystemIdentity !== workspaceId ||
          contextBinding.configurationRevision !==
            binding.configurationRevision ||
          contextBinding.runtimeDriver !== binding.runtimeDriver ||
          contextBinding.runtimeVersion !== binding.runtimeVersion ||
          contextBinding.launchProfileId !== binding.launchProfileId ||
          contextPolicy.maximumExecutionLimitSeconds !==
            bindingPolicy.maximumExecutionLimitSeconds ||
          contextPolicy.maximumInputWaitSeconds !==
            bindingPolicy.maximumInputWaitSeconds
        ) {
          throwFailure(
            "operation_conflict",
            "Context binding changed before dispatch",
            taskId,
          );
        }
        if (
          row.state !== "queued" ||
          !isEligibleContextHead(
            scope,
            authorizedAgentIds(p.allowedAgentIds),
            taskId,
          )
        ) {
          throwFailure(
            "invalid_state",
            "task is not an eligible Context queue head",
            taskId,
          );
        }
        const activeExecutions = Number(
          (
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM execution_workspace_claims WHERE status IN ('held','quarantined')",
              )
              .get() as { count: number }
          ).count,
        );
        if (activeExecutions >= (options.activeExecutionCapacity ?? 4)) {
          throwFailure(
            "queue_capacity",
            "global active execution capacity is exhausted",
            taskId,
          );
        }
        const continuationIntent = db
          .prepare(
            "SELECT mode,context_summary FROM context_continuations WHERE context_id=? AND target_task_id=? AND consumed_by_execution_id IS NULL",
          )
          .get(row.context_id, taskId) as Record<string, unknown> | undefined;
        let launchContinuation:
          | {
              kind: "resume";
              sourceReference: {
                executionId: string;
                generation: string;
                daemonEpoch: string;
                launchProfileId: string;
                workspaceIdentity: string;
              };
              sessionReference: string;
              protectedSessionToken: string;
            }
          | { kind: "fresh_session"; contextSummary: string }
          | undefined;
        if (continuationIntent?.mode === "preserve") {
          const tokenRow = db
            .prepare(
              `SELECT token.*,source.execution_id,source.generation,source.daemon_epoch,source.launch_profile_id,source.workspace_id
             FROM runtime_session_tokens token
             JOIN executions source ON source.execution_id=token.source_execution_id
             WHERE token.context_id=? AND token.state='current'`,
            )
            .get(row.context_id) as Record<string, unknown> | undefined;
          if (
            tokenRow === undefined ||
            tokenRow.workspace_identity !== workspaceId ||
            tokenRow.runtime_driver !== binding.runtimeDriver ||
            tokenRow.runtime_version !== binding.runtimeVersion
          ) {
            throwFailure(
              "invalid_state",
              "protected continuation is unavailable",
            );
          }
          const protectedSessionToken = decryptContinuationToken(tokenRow);
          if (
            tokenRow.session_reference !==
            sessionReferenceFor(
              {
                executionId: String(tokenRow.execution_id),
                generation: String(tokenRow.generation),
                daemonEpoch: String(tokenRow.daemon_epoch),
                launchProfileId: String(tokenRow.launch_profile_id),
                workspaceIdentity: String(tokenRow.workspace_id),
              },
              protectedSessionToken,
            )
          ) {
            throwFailure(
              "invalid_state",
              "protected continuation is unavailable",
            );
          }
          launchContinuation = {
            kind: "resume",
            sourceReference: {
              executionId: String(tokenRow.execution_id),
              generation: String(tokenRow.generation),
              daemonEpoch: String(tokenRow.daemon_epoch),
              launchProfileId: String(tokenRow.launch_profile_id),
              workspaceIdentity: String(tokenRow.workspace_id),
            },
            sessionReference: String(tokenRow.session_reference),
            protectedSessionToken,
          };
          const invalidated = db
            .prepare(
              "UPDATE runtime_session_tokens SET state='invalidated',invalidated_at=? WHERE session_reference=? AND context_id=? AND state='current'",
            )
            .run(stamp, tokenRow.session_reference, row.context_id);
          if (invalidated.changes !== 1) {
            throwFailure(
              "operation_conflict",
              "protected continuation dispatch lost its claim",
            );
          }
          db.prepare(
            "UPDATE contexts SET session_reference=NULL WHERE context_id=?",
          ).run(row.context_id);
        } else if (continuationIntent?.mode === "fresh_session") {
          if (typeof continuationIntent.context_summary !== "string") {
            throwFailure("invalid_state", "fresh continuation is unavailable");
          }
          launchContinuation = {
            kind: "fresh_session",
            contextSummary: continuationIntent.context_summary,
          };
        }
        const executionLimitSeconds =
          row.execution_limit_seconds === null ||
          row.execution_limit_seconds === undefined
            ? Math.min(
                3_600,
                Number(bindingPolicy.maximumExecutionLimitSeconds),
              )
            : Number(row.execution_limit_seconds);
        const inputWaitSeconds =
          row.input_wait_seconds === null ||
          row.input_wait_seconds === undefined
            ? Math.min(86_400, Number(bindingPolicy.maximumInputWaitSeconds))
            : Number(row.input_wait_seconds);
        db.prepare(
          "UPDATE tasks SET execution_limit_seconds=?,input_wait_seconds=? WHERE task_id=?",
        ).run(executionLimitSeconds, inputWaitSeconds, taskId);
        db.prepare(
          "INSERT INTO executions(execution_id,task_id,binding_snapshot_id,generation,daemon_epoch,launch_profile_id,workspace_id,state,lifecycle_state,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'prepared',?,1,?,?)",
        ).run(
          executionId,
          taskId,
          row.context_binding_snapshot_id,
          generation,
          daemonEpoch,
          binding.launchProfileId,
          workspaceId,
          dispatchIntent ? "starting" : null,
          stamp,
          stamp,
        );
        db.prepare(
          "INSERT INTO execution_workspace_claims(workspace_id,execution_id,status,claimed_at,updated_at) VALUES(?,?,'held',?,?)",
        ).run(workspaceId, executionId, stamp, stamp);
        if (continuationIntent !== undefined) {
          const consumed = db
            .prepare(
              "UPDATE context_continuations SET consumed_by_execution_id=?,updated_at=? WHERE context_id=? AND target_task_id=? AND consumed_by_execution_id IS NULL",
            )
            .run(executionId, stamp, row.context_id, taskId);
          if (consumed.changes !== 1) {
            throwFailure(
              "operation_conflict",
              "continuation dispatch lost its claim",
            );
          }
        }
        db.prepare(
          "UPDATE tasks SET state='paused',lifecycle_state=?,reason=?,revision=revision+1,updated_at=? WHERE task_id=?",
        ).run(
          dispatchIntent ? "starting" : null,
          dispatchIntent ? "execution_starting" : "execution_prepared",
          stamp,
          taskId,
        );
        const prepared = execution(
          db
            .prepare(
              "SELECT e.*,w.status AS claim_status FROM executions e JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE e.execution_id=?",
            )
            .get(executionId) as Record<string, unknown>,
        );
        return launchContinuation === undefined
          ? prepared
          : { ...prepared, launchContinuation };
      },
      acquireDispatchCommitFence,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed/.test(error.message)
    ) {
      throwFailure(
        "operation_conflict",
        "Workspace already has an execution claim",
        taskId,
      );
    }
    throw error;
  }
}
function markExecutionRunning(p: Record<string, unknown>) {
  const reference = p.reference;
  if (
    !isRecord(reference) ||
    typeof reference.executionId !== "string" ||
    typeof reference.generation !== "string" ||
    typeof reference.daemonEpoch !== "string" ||
    typeof reference.launchProfileId !== "string" ||
    typeof reference.workspaceIdentity !== "string"
  ) {
    throwFailure("operation_conflict", "execution reference is invalid");
  }
  const stamp = typeof p.now === "string" ? p.now : now();
  if (!Number.isFinite(Date.parse(stamp))) {
    throwFailure("operation_conflict", "execution accounting is invalid");
  }
  return db.transaction(() => {
    const row = db
      .prepare(
        "SELECT e.*,t.lifecycle_state AS task_lifecycle_state,w.status AS claim_status FROM executions e JOIN tasks t ON t.task_id=e.task_id LEFT JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE e.execution_id=? AND e.generation=? AND e.daemon_epoch=? AND e.launch_profile_id=? AND e.workspace_id=?",
      )
      .get(
        reference.executionId,
        reference.generation,
        reference.daemonEpoch,
        reference.launchProfileId,
        reference.workspaceIdentity,
      ) as Record<string, unknown> | undefined;
    if (
      row !== undefined &&
      row.lifecycle_state === "stopping" &&
      row.task_lifecycle_state === "stopping" &&
      row.stop_reason === "cancellation"
    ) {
      return { kind: "stop_required", execution: execution(row) };
    }
    if (
      row === undefined ||
      row.lifecycle_state !== "starting" ||
      row.task_lifecycle_state !== "starting" ||
      row.stop_reason !== null
    ) {
      throwFailure(
        "operation_conflict",
        "execution cannot enter running state",
      );
    }
    db.prepare(
      "UPDATE executions SET lifecycle_state='running',accounting_phase='active',accounting_phase_started_at=?,revision=revision+1,updated_at=? WHERE execution_id=?",
    ).run(stamp, stamp, reference.executionId);
    db.prepare(
      "UPDATE tasks SET lifecycle_state='running',reason=NULL,revision=revision+1,updated_at=? WHERE task_id=?",
    ).run(stamp, row.task_id);
    return {
      kind: "running",
      execution: execution(
        db
          .prepare(
            "SELECT e.*,w.status AS claim_status FROM executions e JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE e.execution_id=?",
          )
          .get(reference.executionId) as Record<string, unknown>,
      ),
    };
  })();
}
function quarantineExecutionForDispatch(p: Record<string, unknown>) {
  const reference = p.reference;
  if (
    !isRecord(reference) ||
    typeof reference.executionId !== "string" ||
    typeof reference.generation !== "string" ||
    typeof reference.daemonEpoch !== "string" ||
    typeof reference.launchProfileId !== "string" ||
    typeof reference.workspaceIdentity !== "string"
  ) {
    throwFailure("operation_conflict", "execution reference is invalid");
  }
  const stamp = now();
  return db.transaction(() => {
    const row = db
      .prepare(
        "SELECT e.*,t.lifecycle_state AS task_lifecycle_state,w.status AS claim_status FROM executions e JOIN tasks t ON t.task_id=e.task_id LEFT JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE e.execution_id=? AND e.generation=? AND e.daemon_epoch=? AND e.launch_profile_id=? AND e.workspace_id=?",
      )
      .get(
        reference.executionId,
        reference.generation,
        reference.daemonEpoch,
        reference.launchProfileId,
        reference.workspaceIdentity,
      ) as Record<string, unknown> | undefined;
    if (
      row === undefined ||
      (row.lifecycle_state !== "starting" &&
        row.lifecycle_state !== "stopping") ||
      row.task_lifecycle_state !== row.lifecycle_state
    ) {
      throwFailure("operation_conflict", "execution cannot be quarantined");
    }
    if (row.lifecycle_state === "stopping") return execution(row);
    db.prepare(
      "UPDATE executions SET state='recovering',lifecycle_state='recovering',recovery_reason='supervisor_start_indeterminate',recovery_started_at=?,revision=revision+1,updated_at=? WHERE execution_id=?",
    ).run(stamp, stamp, reference.executionId);
    db.prepare(
      "UPDATE tasks SET lifecycle_state='recovering',reason='supervisor_start_indeterminate',revision=revision+1,updated_at=? WHERE task_id=?",
    ).run(stamp, row.task_id);
    db.prepare(
      "UPDATE execution_workspace_claims SET status='quarantined',updated_at=? WHERE execution_id=?",
    ).run(stamp, reference.executionId);
    return execution(
      db
        .prepare(
          "SELECT e.*,w.status AS claim_status FROM executions e JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE e.execution_id=?",
        )
        .get(reference.executionId) as Record<string, unknown>,
    );
  })();
}
function interruptExecution(p: Record<string, unknown>) {
  const reference = p.reference;
  if (!isRecord(reference)) {
    throwFailure("operation_conflict", "execution reference is invalid");
  }
  const stamp = now();
  const activeElapsedMs = Number(p.activeElapsedMs ?? 0);
  if (!Number.isSafeInteger(activeElapsedMs) || activeElapsedMs < 0) {
    throwFailure("operation_conflict", "execution accounting is invalid");
  }
  return db.transaction(() => {
    const row = db
      .prepare(
        "SELECT e.*,t.lifecycle_state AS task_lifecycle_state,w.status AS claim_status FROM executions e JOIN tasks t ON t.task_id=e.task_id JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE e.execution_id=? AND e.generation=? AND e.daemon_epoch=? AND e.launch_profile_id=? AND e.workspace_id=?",
      )
      .get(
        reference.executionId,
        reference.generation,
        reference.daemonEpoch,
        reference.launchProfileId,
        reference.workspaceIdentity,
      ) as Record<string, unknown> | undefined;
    if (row === undefined || row.claim_status !== "held") {
      throwFailure("operation_conflict", "execution cannot be interrupted");
    }
    if (row.stop_reason !== null) {
      return execution(row);
    }
    db.prepare(
      "UPDATE executions SET lifecycle_state='stopping',recovery_reason='runtime_interruption',recovery_started_at=COALESCE(recovery_started_at,?),accumulated_execution_ms=accumulated_execution_ms+CASE WHEN accounting_phase='active' THEN ? ELSE 0 END,accounting_phase='stopped',accounting_phase_started_at=NULL,revision=revision+1,updated_at=? WHERE execution_id=?",
    ).run(stamp, activeElapsedMs, stamp, row.execution_id);
    db.prepare(
      "UPDATE tasks SET lifecycle_state='stopping',input_state=NULL,reason='execution_interrupted',revision=revision+1,updated_at=? WHERE task_id=?",
    ).run(stamp, row.task_id);
    db.prepare(
      "UPDATE questions SET state=CASE WHEN state='accepted' THEN 'closed' ELSE state END,closed_at=COALESCE(closed_at,?),closure_reason=COALESCE(closure_reason,'terminal'),delivery_state=CASE WHEN state='accepted' AND delivery_state='pending' THEN 'unknown' ELSE delivery_state END,delivery_unknown_at=CASE WHEN state='accepted' AND delivery_state='pending' THEN ? ELSE delivery_unknown_at END WHERE task_id=? AND closed_at IS NULL AND state IN ('pending','accepted')",
    ).run(stamp, stamp, row.task_id);
    const updated = db
      .prepare(
        "SELECT e.*,w.status AS claim_status FROM executions e JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE e.execution_id=?",
      )
      .get(row.execution_id) as Record<string, unknown>;
    return execution(updated);
  })();
}
function recoverExecutions(p: Record<string, unknown>) {
  const recoveryReason = p.reason ?? "daemon_restart";
  if (
    recoveryReason !== "daemon_restart" &&
    recoveryReason !== "daemon_shutdown"
  ) {
    throwFailure("operation_conflict", "recovery reason is invalid");
  }
  const stamp = now();
  db.transaction(() => {
    const active = db
      .prepare(
        "SELECT e.execution_id FROM executions e JOIN execution_workspace_claims claim ON claim.execution_id=e.execution_id WHERE claim.status IN ('held','quarantined') AND NOT EXISTS (SELECT 1 FROM execution_terminals terminal WHERE terminal.execution_id=e.execution_id)",
      )
      .all() as {
      execution_id: string;
    }[];
    if (active.length === 0) return;
    db.prepare(
      "UPDATE tasks SET lifecycle_state='recovering',reason=?,revision=revision+1,updated_at=? WHERE task_id IN (SELECT e.task_id FROM executions e JOIN execution_workspace_claims claim ON claim.execution_id=e.execution_id WHERE e.lifecycle_state IS NOT NULL AND claim.status IN ('held','quarantined') AND NOT EXISTS (SELECT 1 FROM execution_terminals terminal WHERE terminal.execution_id=e.execution_id))",
    ).run(recoveryReason, stamp);
    db.prepare(
      "UPDATE executions SET state='recovering',lifecycle_state=CASE WHEN lifecycle_state IS NULL THEN NULL ELSE 'recovering' END,accounting_phase='stopped',accounting_phase_started_at=NULL,recovery_reason=COALESCE(recovery_reason,?),recovery_started_at=COALESCE(recovery_started_at,?),revision=revision+1,updated_at=? WHERE state='prepared' AND execution_id IN (SELECT execution_id FROM execution_workspace_claims WHERE status IN ('held','quarantined'))",
    ).run(recoveryReason, stamp, stamp);
    db.prepare(
      "UPDATE execution_workspace_claims SET status='quarantined',updated_at=? WHERE execution_id IN (SELECT execution_id FROM executions WHERE state='recovering')",
    ).run(stamp);
    db.prepare(
      "INSERT INTO context_blockers(context_id,predecessor_task_id,state,created_at) SELECT t.context_id,e.task_id,'recovering',? FROM executions e JOIN tasks t ON t.task_id=e.task_id JOIN execution_workspace_claims claim ON claim.execution_id=e.execution_id WHERE e.state='recovering' AND e.lifecycle_state='recovering' AND claim.status='quarantined' ON CONFLICT(context_id) DO NOTHING",
    ).run(stamp);
    db.prepare(
      "UPDATE tasks SET state='paused',reason='predecessor_blocked',revision=revision+1,updated_at=? WHERE lifecycle_state IS NULL AND state IN ('queued','paused') AND context_id IN (SELECT t.context_id FROM executions e JOIN tasks t ON t.task_id=e.task_id WHERE e.state='recovering' AND e.lifecycle_state='recovering')",
    ).run(stamp);
    db.prepare(
      "UPDATE contexts SET revision=revision+1,pause_reason='predecessor_blocked' WHERE context_id IN (SELECT t.context_id FROM executions e JOIN tasks t ON t.task_id=e.task_id WHERE e.state='recovering' AND e.lifecycle_state='recovering')",
    ).run();
    db.prepare(
      "UPDATE runtime_session_tokens SET state='invalidated',invalidated_at=? WHERE state='current' AND EXISTS (SELECT 1 FROM context_continuations continuation JOIN executions e ON e.execution_id=continuation.consumed_by_execution_id WHERE continuation.context_id=runtime_session_tokens.context_id AND continuation.mode='preserve' AND e.state='recovering' AND e.lifecycle_state='recovering')",
    ).run(stamp);
    db.prepare(
      "UPDATE contexts SET session_reference=NULL WHERE EXISTS (SELECT 1 FROM context_continuations continuation JOIN executions e ON e.execution_id=continuation.consumed_by_execution_id WHERE continuation.context_id=contexts.context_id AND continuation.mode='preserve' AND e.state='recovering' AND e.lifecycle_state='recovering')",
    ).run();
    db.prepare(
      "UPDATE questions SET delivery_state='unknown',delivery_unknown_at=? WHERE state='accepted' AND delivery_state='pending' AND execution_id IN (SELECT execution_id FROM executions WHERE lifecycle_state IS NOT NULL)",
    ).run(stamp);
    db.prepare(
      "UPDATE questions SET closed_at=?,closure_reason='recovery' WHERE state='pending' AND closed_at IS NULL AND execution_id IN (SELECT execution_id FROM executions WHERE lifecycle_state IS NOT NULL)",
    ).run(stamp);
  })();
  return (
    db
      .prepare(
        "SELECT e.*,w.status AS claim_status FROM executions e JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE e.lifecycle_state IS NOT NULL AND w.status IN ('held','quarantined')",
      )
      .all() as Record<string, unknown>[]
  ).map(execution);
}

function confirmRecoveryStopped(p: Record<string, unknown>): void {
  const evidenceValue = p.evidence;
  const stamp = typeof p.now === "string" ? p.now : now();
  if (!isRecord(evidenceValue) || !isRecord(evidenceValue.reference)) {
    throwFailure("operation_conflict", "recovery stop evidence is invalid");
  }
  const reference = evidenceValue.reference;
  db.transaction(() => {
    const row = db
      .prepare(
        "SELECT e.*,w.status AS claim_status FROM executions e JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE e.execution_id=? AND e.generation=? AND e.daemon_epoch=? AND e.launch_profile_id=? AND e.workspace_id=?",
      )
      .get(
        reference.executionId,
        reference.generation,
        reference.daemonEpoch,
        reference.launchProfileId,
        reference.workspaceIdentity,
      ) as Record<string, unknown> | undefined;
    if (
      row === undefined ||
      row.lifecycle_state !== "recovering" ||
      row.claim_status !== "quarantined" ||
      !validTerminalEvidence(row, evidenceValue)
    ) {
      throwFailure("operation_conflict", "recovery stop evidence is invalid");
    }
    db.prepare(
      "INSERT INTO execution_recovery_stop_confirmations(execution_id,generation,daemon_epoch,launch_profile_id,workspace_identity,execution_unit_id,generation_sealed_at,unit_empty_observed_at,confirmed_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(execution_id) DO NOTHING",
    ).run(
      row.execution_id,
      row.generation,
      row.daemon_epoch,
      row.launch_profile_id,
      row.workspace_id,
      evidenceValue.executionUnitId,
      evidenceValue.generationSealedAt,
      evidenceValue.unitEmptyObservedAt,
      stamp,
    );
  })();
}
function quarantineExecution(p: Record<string, unknown>) {
  const scope = String(p.accessScopeId);
  const taskId = String(p.taskId);
  const stamp = now();
  return db.transaction(() => {
    const agentIds = authorizedAgentIds(p.allowedAgentIds);
    const row =
      agentIds.length === 0
        ? undefined
        : (db
            .prepare(
              `SELECT e.execution_id FROM executions e JOIN tasks t ON t.task_id=e.task_id WHERE t.scope=? AND e.task_id=? AND t.agent_id IN (${agentIds.map(() => "?").join(",")})`,
            )
            .get(scope, taskId, ...agentIds) as
            { execution_id: string } | undefined);
    if (row === undefined) throwFailure("not_found", "execution was not found");
    db.prepare(
      "UPDATE executions SET state='recovering',revision=revision+1,updated_at=? WHERE execution_id=?",
    ).run(stamp, row.execution_id);
    db.prepare(
      "UPDATE execution_workspace_claims SET status='quarantined',updated_at=? WHERE execution_id=?",
    ).run(stamp, row.execution_id);
    return execution(
      db
        .prepare(
          "SELECT e.*,w.status AS claim_status FROM executions e JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE e.execution_id=?",
        )
        .get(row.execution_id) as Record<string, unknown>,
    );
  })();
}
function throwFailure(
  code: Failure["code"],
  message: string,
  taskId?: string,
): never {
  throw Object.assign(new Error(message), {
    storageFailure: {
      code,
      message,
      ...(taskId === undefined || taskId.length === 0 ? {} : { taskId }),
    } satisfies Failure,
  });
}
function requireWritableLifecycle(): void {
  if (options.recoveryOnly === true) {
    throwFailure(
      "invalid_state",
      "recovery-only storage cannot admit or advance execution work",
    );
  }
}
function receipt(
  scope: string,
  operationId: string,
  operationType: string,
  targetId: string | null,
  fingerprint: string,
  authorizedAgents?: readonly string[],
  expectedAgentId?: string,
) {
  const existing = db
    .prepare(
      "SELECT * FROM operation_receipts WHERE scope=? AND operation_id=?",
    )
    .get(scope, operationId) as Record<string, unknown> | undefined;
  if (!existing) return undefined;
  const existingTaskId =
    typeof existing.retained_task_id === "string"
      ? existing.retained_task_id
      : legacyReceiptTaskId(existing);
  if (authorizedAgents !== undefined) {
    if (existingTaskId === undefined) {
      throwFailure("not_found", "Resource not found");
    }
    const taskAgent = db
      .prepare(
        actualTables.has("task_expiry_markers")
          ? `SELECT agent_id FROM tasks WHERE task_id=?
             UNION ALL
             SELECT agent_id FROM task_expiry_markers WHERE task_id=?
             LIMIT 1`
          : "SELECT agent_id FROM tasks WHERE task_id=? LIMIT 1",
      )
      .get(
        ...(actualTables.has("task_expiry_markers")
          ? [existingTaskId, existingTaskId]
          : [existingTaskId]),
      ) as { agent_id: string } | undefined;
    if (
      taskAgent === undefined ||
      !authorizedAgents.includes(taskAgent.agent_id) ||
      (expectedAgentId !== undefined && taskAgent.agent_id !== expectedAgentId)
    ) {
      throwFailure("not_found", "Resource not found");
    }
  }
  if (
    existing.operation_type !== operationType ||
    existing.target_id !== targetId ||
    existing.fingerprint !== fingerprint
  )
    throwFailure(
      "operation_conflict",
      "operationId was already used for a different operation",
      existingTaskId,
    );
  if (typeof existing.expired_at === "string") {
    throwFailure(
      "result_expired",
      "retained operation result has expired",
      existingTaskId,
    );
  }
  const result: unknown = JSON.parse(String(existing.result_json));
  return result;
}
function legacyReceiptTaskId(
  existing: Record<string, unknown>,
): string | undefined {
  try {
    const result: unknown = JSON.parse(String(existing.result_json));
    return isRecord(result) && typeof result.taskId === "string"
      ? result.taskId
      : undefined;
  } catch {
    return undefined;
  }
}
function emit(
  scope: string,
  taskId: string,
  revision: number,
  eventType: string,
  occurredAt = now(),
) {
  const cursor =
    Number(
      (
        db
          .prepare(
            actualTables.has("task_expiry_markers")
              ? "SELECT MAX(cursor) AS cursor FROM (SELECT COALESCE(MAX(cursor),0) AS cursor FROM task_events WHERE scope=? UNION ALL SELECT COALESCE(MAX(max_event_cursor),0) AS cursor FROM task_expiry_markers WHERE scope=?)"
              : "SELECT COALESCE(MAX(cursor),0) AS cursor FROM task_events WHERE scope=?",
          )
          .get(
            ...(actualTables.has("task_expiry_markers")
              ? [scope, scope]
              : [scope]),
          ) as { cursor: number }
      ).cursor,
    ) + 1;
  const sequence =
    Number(
      (
        db
          .prepare(
            "SELECT COALESCE(MAX(task_sequence), 0) AS sequence FROM task_events WHERE task_id=?",
          )
          .get(taskId) as { sequence: number }
      ).sequence,
    ) + 1;
  db.prepare(
    "INSERT INTO task_events(scope, cursor, task_id, task_sequence, revision, event_type, payload_json, created_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(scope, cursor, taskId, sequence, revision, eventType, "{}", occurredAt);
}
function maybeFail(): void {
  if (failNextStorageBusy) {
    failNextStorageBusy = false;
    const error = new Error("injected SQLite write lock");
    Object.assign(error, { code: "SQLITE_BUSY" });
    throw error;
  }
  if (failNextStorageFull) {
    failNextStorageFull = false;
    const error = new Error("injected physical storage full");
    Object.assign(error, { code: "SQLITE_FULL" });
    throw error;
  }
  if (failNextStorageIo) {
    failNextStorageIo = false;
    const error = new Error("injected physical storage I/O failure");
    Object.assign(error, { code: "SQLITE_IOERR" });
    throw error;
  }
  if (failNextCommit) {
    failNextCommit = false;
    throwFailure("storage_unavailable", "injected commit failure");
  }
}
function requireRegistryRevision(value: unknown): void {
  if (Number(value ?? 0) !== Atomics.load(registryRevisionFence, 0)) {
    throwFailure(
      "authorization_changed",
      "Registry authorization changed before commit",
    );
  }
}
function acquireRegistryCommitFence(): void {
  while (Atomics.compareExchange(registryRevisionFence, 1, 0, 1) !== 0) {
    Atomics.wait(registryRevisionFence, 1, 1);
  }
}
function releaseRegistryCommitFence(): void {
  Atomics.store(registryRevisionFence, 1, 0);
  Atomics.notify(registryRevisionFence, 1);
}
function waitAtTestCommitBarrier(): void {
  if (Atomics.load(testCommitBarrier, 0) !== 1) return;
  Atomics.store(testCommitBarrier, 1, 1);
  Atomics.notify(testCommitBarrier, 1);
  Atomics.wait(testCommitBarrier, 0, 1);
}
function waitAtTestDispatchCommitBarrier(): void {
  if (Atomics.load(testDispatchCommitBarrier, 0) !== 1) return;
  Atomics.store(testDispatchCommitBarrier, 1, 1);
  Atomics.notify(testDispatchCommitBarrier, 1);
  Atomics.wait(testDispatchCommitBarrier, 0, 1);
  if (Atomics.exchange(testDispatchCommitBarrier, 2, 0) === 1) {
    throw new Error("test dispatch commit rollback");
  }
}
function acquireDispatchCommitFence(): () => void {
  if (Atomics.compareExchange(dispatchAdmissionFence, 0, 1, 2) !== 1) {
    throwFailure("invalid_state", "dispatch admission is closed");
  }
  return () => {
    const state = Atomics.compareExchange(dispatchAdmissionFence, 0, 2, 1);
    if (state === 3) Atomics.store(dispatchAdmissionFence, 0, 0);
  };
}
function registryFencedTransaction<T>(
  expectedRevision: unknown,
  operation: () => T,
  acquireCommitFence?: () => () => void,
): T {
  db.exec("BEGIN IMMEDIATE");
  let releaseCommitFence: (() => void) | undefined;
  try {
    requireRegistryRevision(expectedRevision);
    const result = operation();
    // The deterministic commit fault applies to every registry-fenced mutation,
    // including reserved controls such as reply. Individual operations may call
    // this earlier to target a narrower crash window; the one-shot flag makes
    // this final boundary a no-op in those cases.
    maybeFail();
    waitAtTestCommitBarrier();
    releaseCommitFence = acquireCommitFence?.();
    if (releaseCommitFence !== undefined) waitAtTestDispatchCommitBarrier();
    acquireRegistryCommitFence();
    try {
      requireRegistryRevision(expectedRevision);
      db.exec("COMMIT");
    } finally {
      releaseRegistryCommitFence();
    }
    releaseCommitFence?.();
    releaseCommitFence = undefined;
    return result;
  } catch (error) {
    releaseCommitFence?.();
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
function registryFencedRead<T>(
  expectedRevision: unknown,
  operation: () => T,
): T {
  acquireRegistryCommitFence();
  try {
    requireRegistryRevision(expectedRevision);
    return operation();
  } finally {
    releaseRegistryCommitFence();
  }
}
function transitionTasks(p: Record<string, unknown>): void {
  const fromState = String(p.fromState);
  const toState = String(p.toState);
  const reason = String(p.reason);
  const eventType = String(p.eventType);
  const restartBytes = Math.floor(taskControlReserveBytes / 2);
  const queuedCount = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM tasks WHERE state=?")
        .get(fromState) as { count: number }
    ).count,
  );
  checkpointWal();
  try {
    releasePhysicalControlReserve(queuedCount * restartBytes);
    requirePhysicalHeadroom(physicalCapacityBytes, queuedCount * 4 * pageSize);
    db.transaction(() => {
      const rows = db
        .prepare("SELECT * FROM tasks WHERE state=?")
        .all(fromState) as Record<string, unknown>[];
      for (const row of rows) {
        const reserve = db
          .prepare(
            "SELECT control_events,control_bytes FROM task_reservations WHERE task_id=?",
          )
          .get(row.task_id) as
          { control_events: number; control_bytes: number } | undefined;
        if (
          !reserve ||
          Number(reserve.control_events) < 1 ||
          Number(reserve.control_bytes) < restartBytes
        ) {
          throwFailure("storage_capacity", "task control reserve is exhausted");
        }
      }
      for (const row of rows) {
        const stamp = now();
        const revision = Number(row.revision) + 1;
        db.prepare(
          "UPDATE tasks SET state=?, reason=?, revision=?, updated_at=? WHERE task_id=? AND state=?",
        ).run(toState, reason, revision, stamp, row.task_id, fromState);
        db.prepare(
          "UPDATE contexts SET revision=revision+1, pause_reason=? WHERE context_id=?",
        ).run(reason, row.context_id);
        db.prepare(
          "UPDATE task_reservations SET control_events=control_events-1,control_bytes=control_bytes-? WHERE task_id=?",
        ).run(restartBytes, row.task_id);
        changeCapacity("reserved_control_bytes", -restartBytes);
        emit(
          String(row.scope),
          String(row.task_id),
          revision,
          eventType,
          stamp,
        );
      }
      requirePhysicalHeadroom(physicalCapacityBytes);
    })();
  } catch (error) {
    try {
      reconcilePhysicalControlReserve();
    } catch {
      throwFailure(
        "storage_unavailable",
        "physical control reserve reconciliation failed",
      );
    }
    throw error;
  }
}

function submit(p: Record<string, unknown>) {
  const scope = String(p.accessScopeId);
  const operationId = String(p.operationId);
  const fingerprint = String(p.fingerprint);
  const taskId = String(p.taskId);
  const contextId = String(p.contextId);
  const existingContextId =
    typeof p.existingContextId === "string" ? p.existingContextId : undefined;
  const binding = p.binding as Record<string, unknown>;
  const bindingSnapshotId = String(binding.bindingSnapshotId);
  const agentId = String(p.agentId);
  const bindingWorkspace = binding.workspaceIdentity;
  if (
    !isRecord(bindingWorkspace) ||
    typeof bindingWorkspace.filesystemIdentity !== "string"
  ) {
    throw new Error("invalid internal binding Workspace identity");
  }
  const workspaceId = bindingWorkspace.filesystemIdentity;
  const instruction = String(p.instruction);
  const principalId = String(p.principalId);
  checkpointWal();
  const estimatedGrowth = submitGrowthEstimate(instruction, binding);
  const reusesFreelist = reusableFreelistBytes(physicalAdmissionBytes) > 0;
  try {
    const result = registryFencedTransaction(p.expectedRegistryRevision, () => {
      const old = receipt(
        scope,
        operationId,
        "submit",
        null,
        fingerprint,
        [agentId],
        agentId,
      );
      if (old) return { task: old, replayed: true };
      const expiredIdentity = db
        .prepare(
          "SELECT scope,agent_id FROM task_expiry_markers WHERE task_id=?",
        )
        .get(taskId) as { scope: string; agent_id: string } | undefined;
      if (expiredIdentity !== undefined) {
        if (
          expiredIdentity.scope === scope &&
          expiredIdentity.agent_id === agentId
        ) {
          throwFailure(
            "result_expired",
            "retained Task result has expired",
            taskId,
          );
        }
        throwFailure("operation_conflict", "Task identity is unavailable");
      }
      if (
        existingContextId === undefined &&
        db
          .prepare(
            "SELECT 1 FROM task_expiry_markers WHERE context_id=? LIMIT 1",
          )
          .get(contextId) !== undefined
      ) {
        throwFailure("operation_conflict", "Context identity is unavailable");
      }
      const existingContext =
        existingContextId === undefined
          ? undefined
          : (db
              .prepare(
                "SELECT c.context_id,c.agent_id,c.binding_snapshot_id,b.workspace_id FROM contexts c JOIN binding_snapshots b ON b.binding_snapshot_id=c.binding_snapshot_id WHERE c.scope=? AND c.context_id=?",
              )
              .get(scope, existingContextId) as
              Record<string, unknown> | undefined);
      if (existingContextId !== undefined && existingContext === undefined) {
        throwFailure("not_found", "context was not found");
      }
      if (
        existingContext !== undefined &&
        existingContext.agent_id !== agentId
      ) {
        throwFailure("not_found", "context was not found");
      }
      const contextWorkspaceId =
        existingContext === undefined
          ? workspaceId
          : String(existingContext.workspace_id);
      const predecessorTaskId =
        existingContext === undefined
          ? null
          : ((
              db
                .prepare(
                  "SELECT task_id FROM tasks WHERE context_id=? ORDER BY queue_order DESC LIMIT 1",
                )
                .get(existingContext.context_id) as
                { task_id: string } | undefined
            )?.task_id ?? null);
      if (existingContext !== undefined && predecessorTaskId === null) {
        throwFailure("invalid_state", "context has no accepted Task");
      }
      const contextBlocked =
        existingContext !== undefined &&
        db
          .prepare("SELECT 1 FROM context_blockers WHERE context_id=?")
          .get(existingContext.context_id) !== undefined;
      requirePhysicalHeadroom(
        physicalAdmissionBytes,
        estimatedGrowth,
        taskControlReserveBytes,
      );
      const receiptCount = capacityValue("general_receipts");
      if (receiptCount >= (options.receiptCapacity ?? 100_000))
        throwFailure(
          "tombstone_capacity",
          "general receipt capacity is exhausted",
        );
      const byteCount = capacityValue("admission_bytes");
      if (
        byteCount + Buffer.byteLength(instruction) >
        (options.admissionBytes ?? 2 * 1024 * 1024 * 1024)
      )
        throwFailure(
          "storage_capacity",
          "logical admission byte budget is exhausted",
        );
      const global = capacityValue("active_global");
      const local = capacityValue(workspaceCapacityKey(contextWorkspaceId));
      if (
        global >= (options.queueGlobal ?? 256) ||
        local >= (options.queuePerWorkspace ?? 32)
      )
        throwFailure("queue_capacity", "queue capacity is exhausted");
      if (
        capacityValue("reserved_control_bytes") + taskControlReserveBytes >
        physicalControlReserveBytes
      ) {
        throwFailure(
          "storage_capacity",
          "task control byte reserve is exhausted",
        );
      }
      growPhysicalControlReserve(taskControlReserveBytes);
      const stamp = typeof p.now === "string" ? p.now : now();
      const queueOrder =
        Number(
          (
            db
              .prepare(
                "SELECT MAX(q) AS q FROM (SELECT COALESCE(MAX(queue_order),0) AS q FROM tasks WHERE scope=? UNION ALL SELECT COALESCE(MAX(queue_order),0) AS q FROM task_expiry_markers WHERE scope=?)",
              )
              .get(scope, scope) as { q: number }
          ).q,
        ) + 1;
      if (existingContext === undefined) {
        db.prepare(
          "INSERT INTO binding_snapshots(binding_snapshot_id,scope,agent_id,workspace_id,payload_json,created_at) VALUES(?,?,?,?,?,?)",
        ).run(
          bindingSnapshotId,
          scope,
          agentId,
          workspaceId,
          JSON.stringify(binding),
          stamp,
        );
        db.prepare(
          "INSERT INTO contexts(context_id,scope,agent_id,binding_snapshot_id,revision,created_at) VALUES(?,?,?,?,1,?)",
        ).run(contextId, scope, agentId, bindingSnapshotId, stamp);
      } else {
        db.prepare(
          "UPDATE contexts SET revision=revision+1 WHERE context_id=?",
        ).run(existingContext.context_id);
      }
      db.prepare(
        "INSERT INTO tasks(task_id,context_id,scope,agent_id,created_by,state,reason,revision,queue_order,predecessor_task_id,instruction,execution_limit_seconds,input_wait_seconds,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?,?,?)",
      ).run(
        taskId,
        existingContextId ?? contextId,
        scope,
        agentId,
        principalId,
        contextBlocked ? "paused" : "queued",
        contextBlocked ? "predecessor_blocked" : null,
        queueOrder,
        predecessorTaskId,
        instruction,
        p.executionLimitSeconds ?? null,
        p.inputWaitSeconds ?? null,
        stamp,
        stamp,
      );
      db.prepare(
        "INSERT INTO task_workspace_queue(task_id,workspace_id) VALUES(?,?)",
      ).run(taskId, contextWorkspaceId);
      db.prepare(
        "INSERT INTO task_reservations(task_id,control_receipts,control_events,control_bytes) VALUES(?,?,?,?)",
      ).run(
        taskId,
        options.controlReceiptReserve ?? 2,
        options.controlEventReserve ?? 2,
        taskControlReserveBytes,
      );
      emit(scope, taskId, 1, "accepted", stamp);
      const result = task(
        db.prepare("SELECT * FROM tasks WHERE task_id=?").get(taskId) as Record<
          string,
          unknown
        >,
      );
      maybeFail();
      db.prepare(
        "INSERT INTO operation_receipts(scope,operation_id,operation_type,target_id,fingerprint,actor_principal_id,result_json,created_at) VALUES(?,?, 'submit',NULL,?,?,?,?)",
      ).run(
        scope,
        operationId,
        fingerprint,
        principalId,
        JSON.stringify(result),
        stamp,
      );
      changeCapacity("general_receipts", 1);
      changeCapacity("admission_bytes", Buffer.byteLength(instruction));
      changeCapacity("active_global", 1);
      changeCapacity(workspaceCapacityKey(contextWorkspaceId), 1);
      changeCapacity("reserved_control_bytes", taskControlReserveBytes);
      requirePhysicalHeadroom(physicalAdmissionBytes);
      return { task: result, replayed: false };
    });
    if (reusesFreelist) checkpointWal();
    return result;
  } catch (error) {
    try {
      reconcilePhysicalControlReserve();
    } catch {
      throwFailure(
        "storage_unavailable",
        "physical control reserve reconciliation failed",
      );
    }
    throw error;
  }
}

const MAX_EDIT_INSTRUCTION_BYTES = 64 * 1024;

function edit(p: Record<string, unknown>) {
  const scope = String(p.accessScopeId);
  const operationId = String(p.operationId);
  const fingerprint = String(p.fingerprint);
  const principalId = String(p.principalId);
  const taskId = String(p.taskId);
  const expectedRevision = Number(p.expectedRevision);
  const instruction = String(p.instruction);
  const instructionBytes = Buffer.byteLength(instruction, "utf8");
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1 ||
    instructionBytes > MAX_EDIT_INSTRUCTION_BYTES
  ) {
    throwFailure("operation_conflict", "edit input is invalid", taskId);
  }
  const stamp = typeof p.now === "string" ? p.now : now();
  checkpointWal();
  return registryFencedTransaction(p.expectedRegistryRevision, () => {
    const old = receipt(
      scope,
      operationId,
      "edit",
      taskId,
      fingerprint,
      authorizedAgentIds(p.allowedAgentIds),
    );
    if (old) return { task: old, replayed: true };
    const agentIds = authorizedAgentIds(p.allowedAgentIds);
    const row =
      agentIds.length === 0
        ? undefined
        : (db
            .prepare(
              `SELECT t.* FROM tasks t
               WHERE t.scope=? AND t.task_id=?
                 AND t.agent_id IN (${agentIds.map(() => "?").join(",")})
                 ${
                   actualTables.has("task_expiry_markers")
                     ? `AND NOT EXISTS (
                   SELECT 1 FROM task_expiry_markers marker
                   WHERE marker.task_id=t.task_id
                 )`
                     : ""
                 }`,
            )
            .get(scope, taskId, ...agentIds) as
            Record<string, unknown> | undefined);
    if (row === undefined) throwFailure("not_found", "task was not found");
    if (
      (row.state !== "queued" && row.state !== "paused") ||
      row.lifecycle_state !== null ||
      db.prepare("SELECT 1 FROM executions WHERE task_id=?").get(taskId) !==
        undefined
    ) {
      throwFailure("invalid_state", "task cannot be edited", taskId);
    }
    if (Number(row.revision) !== expectedRevision) {
      throwFailure("operation_conflict", "task revision is stale", taskId);
    }
    const oldInstructionBytes = Buffer.byteLength(
      String(row.instruction),
      "utf8",
    );
    const instructionDelta = instructionBytes - oldInstructionBytes;
    const nextAdmissionBytes =
      capacityValue("admission_bytes") + instructionDelta;
    if (
      nextAdmissionBytes > (options.admissionBytes ?? 2 * 1024 * 1024 * 1024)
    ) {
      throwFailure(
        "storage_capacity",
        "logical admission byte budget is exhausted",
      );
    }
    if (
      capacityValue("general_receipts") >= (options.receiptCapacity ?? 100_000)
    ) {
      throwFailure(
        "tombstone_capacity",
        "general receipt capacity is exhausted",
      );
    }
    requirePhysicalHeadroom(
      physicalAdmissionBytes,
      Math.max(0, instructionDelta) + 4 * pageSize,
    );
    const revision = expectedRevision + 1;
    const updated = db
      .prepare(
        "UPDATE tasks SET instruction=?,revision=?,updated_at=? WHERE task_id=? AND revision=? AND state IN ('queued','paused') AND lifecycle_state IS NULL",
      )
      .run(instruction, revision, stamp, taskId, expectedRevision);
    if (updated.changes !== 1) {
      throwFailure(
        "operation_conflict",
        "task edit lost its compare-and-swap",
        taskId,
      );
    }
    emit(scope, taskId, revision, "edited", stamp);
    const result = task(
      db.prepare("SELECT * FROM tasks WHERE task_id=?").get(taskId) as Record<
        string,
        unknown
      >,
    );
    maybeFail();
    db.prepare(
      "INSERT INTO operation_receipts(scope,operation_id,operation_type,target_id,fingerprint,actor_principal_id,result_json,created_at) VALUES(?,?, 'edit',?,?,?,?,?)",
    ).run(
      scope,
      operationId,
      taskId,
      fingerprint,
      principalId,
      JSON.stringify({ taskId: result.taskId }),
      stamp,
    );
    changeCapacity("general_receipts", 1);
    changeCapacity("admission_bytes", instructionDelta);
    requirePhysicalHeadroom(physicalAdmissionBytes);
    return { task: result, replayed: false };
  });
}

function resumeContext(p: Record<string, unknown>) {
  const scope = String(p.accessScopeId);
  const operationId = String(p.operationId);
  const fingerprint = String(p.fingerprint);
  const principalId = String(p.principalId);
  const contextId = String(p.contextId);
  const expectedRevision = Number(p.expectedRevision);
  const continuationMode = p.continuationMode;
  const hasSummary = Object.hasOwn(p, "contextSummary");
  const contextSummary = p.contextSummary;
  const stamp = typeof p.now === "string" ? p.now : now();
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1 ||
    (continuationMode !== "preserve" && continuationMode !== "fresh_session") ||
    (continuationMode === "preserve" && hasSummary) ||
    (continuationMode === "fresh_session" &&
      (typeof contextSummary !== "string" ||
        Buffer.byteLength(contextSummary, "utf8") > MAX_CONTEXT_SUMMARY_BYTES))
  ) {
    throwFailure("operation_conflict", "Context continuation is invalid");
  }
  checkpointWal();
  return registryFencedTransaction(p.expectedRegistryRevision, () => {
    const prior = receipt(
      scope,
      operationId,
      "resume",
      contextId,
      fingerprint,
      authorizedAgentIds(p.allowedAgentIds),
    );
    if (prior !== undefined) return { task: prior, replayed: true };
    const agentIds = authorizedAgentIds(p.allowedAgentIds);
    const context =
      agentIds.length === 0
        ? undefined
        : (db
            .prepare(
              `SELECT c.*,b.workspace_id,b.payload_json AS binding_payload
               FROM contexts c JOIN binding_snapshots b ON b.binding_snapshot_id=c.binding_snapshot_id
               WHERE c.scope=? AND c.context_id=? AND c.agent_id IN (${agentIds.map(() => "?").join(",")})`,
            )
            .get(scope, contextId, ...agentIds) as
            Record<string, unknown> | undefined);
    if (context === undefined)
      throwFailure("not_found", "context was not found");
    if (
      capacityValue("general_receipts") >= (options.receiptCapacity ?? 100_000)
    ) {
      throwFailure(
        "tombstone_capacity",
        "general receipt capacity is exhausted",
      );
    }
    requirePhysicalHeadroom(
      physicalAdmissionBytes,
      (typeof contextSummary === "string"
        ? Buffer.byteLength(contextSummary, "utf8")
        : 0) +
        4 * pageSize,
    );
    if (Number(context.revision) !== expectedRevision) {
      throwFailure("operation_conflict", "context revision is stale");
    }
    const blocker = db
      .prepare(
        "SELECT predecessor_task_id,state FROM context_blockers WHERE context_id=?",
      )
      .get(contextId) as Record<string, unknown> | undefined;
    if (blocker === undefined) {
      throwFailure(
        "invalid_state",
        "context has no removable predecessor blocker",
      );
    }
    if (blocker.state === "recovering") {
      throwFailure(
        "invalid_state",
        "context recovery must be acknowledged before resumption",
      );
    }
    const resumable = db
      .prepare(
        "SELECT session_reference,runtime_driver,runtime_version,workspace_identity,key_id FROM runtime_session_tokens WHERE context_id=? AND state='current'",
      )
      .get(contextId) as Record<string, unknown> | undefined;
    const binding = continuationBinding(context);
    if (
      continuationMode === "preserve" &&
      (resumable === undefined ||
        continuationEncryptionKey === undefined ||
        binding === undefined ||
        resumable.workspace_identity !== context.workspace_id ||
        resumable.runtime_driver !== binding.runtimeDriver ||
        resumable.runtime_version !== binding.runtimeVersion ||
        resumable.key_id !==
          createHash("sha256")
            .update(continuationEncryptionKey)
            .digest("hex")
            .slice(0, 24))
    ) {
      throwFailure("invalid_state", "protected continuation is unavailable");
    }
    const successor = db
      .prepare(
        "SELECT * FROM tasks WHERE context_id=? AND state='paused' AND lifecycle_state IS NULL AND reason='predecessor_blocked' ORDER BY queue_order LIMIT 1",
      )
      .get(contextId) as Record<string, unknown> | undefined;
    if (successor === undefined) {
      throwFailure("invalid_state", "context has no blocked successor");
    }
    if (continuationMode === "fresh_session") {
      db.prepare(
        "UPDATE runtime_session_tokens SET state='invalidated',invalidated_at=? WHERE context_id=? AND state='current'",
      ).run(stamp, contextId);
      db.prepare(
        "UPDATE contexts SET session_reference=NULL WHERE context_id=?",
      ).run(contextId);
    }
    db.prepare(
      "INSERT INTO context_continuations(context_id,mode,context_summary,native_continuity,updated_at,target_task_id,consumed_by_execution_id) VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(context_id) DO UPDATE SET mode=excluded.mode,context_summary=excluded.context_summary,native_continuity=excluded.native_continuity,updated_at=excluded.updated_at,target_task_id=excluded.target_task_id,consumed_by_execution_id=NULL",
    ).run(
      contextId,
      continuationMode,
      continuationMode === "fresh_session" ? contextSummary : null,
      continuationMode === "fresh_session" ? "abandoned" : "preserved",
      stamp,
      successor.task_id,
    );
    db.prepare("DELETE FROM context_blockers WHERE context_id=?").run(
      contextId,
    );
    db.prepare(
      "UPDATE tasks SET state='queued',reason=NULL,revision=revision+1,updated_at=? WHERE context_id=? AND state='paused' AND lifecycle_state IS NULL AND reason='predecessor_blocked'",
    ).run(stamp, contextId);
    db.prepare(
      "UPDATE contexts SET revision=revision+1,pause_reason=NULL WHERE context_id=?",
    ).run(contextId);
    const result = task(
      db
        .prepare("SELECT * FROM tasks WHERE task_id=?")
        .get(successor.task_id) as Record<string, unknown>,
    );
    db.prepare(
      "INSERT INTO operation_receipts(scope,operation_id,operation_type,target_id,fingerprint,actor_principal_id,result_json,created_at) VALUES(?,?, 'resume',?,?,?,?,?)",
    ).run(
      scope,
      operationId,
      contextId,
      fingerprint,
      principalId,
      JSON.stringify({ taskId: result.taskId }),
      stamp,
    );
    changeCapacity("general_receipts", 1);
    requirePhysicalHeadroom(physicalAdmissionBytes);
    return { task: result, replayed: false };
  });
}

function acknowledgeInterruption(p: Record<string, unknown>) {
  const scope = String(p.accessScopeId);
  const operationId = String(p.operationId);
  const fingerprint = String(p.fingerprint);
  const principalId = String(p.principalId);
  const taskId = String(p.taskId);
  const expectedRevision = Number(p.expectedRevision);
  const stamp = typeof p.now === "string" ? p.now : now();
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throwFailure(
      "operation_conflict",
      "interruption revision is invalid",
      taskId,
    );
  }
  checkpointWal();
  let releaseBytes = 0;
  try {
    const result = registryFencedTransaction(p.expectedRegistryRevision, () => {
      const prior = receipt(
        scope,
        operationId,
        "acknowledge_interruption",
        taskId,
        fingerprint,
        authorizedAgentIds(p.allowedAgentIds),
      );
      if (prior !== undefined) return { task: prior, replayed: true };
      const agentIds = authorizedAgentIds(p.allowedAgentIds);
      const row =
        agentIds.length === 0
          ? undefined
          : (db
              .prepare(
                `SELECT t.*,e.execution_id,e.lifecycle_state AS execution_lifecycle_state,e.recovery_resolution,w.status AS claim_status,b.workspace_id
                   FROM tasks t
                   JOIN executions e ON e.task_id=t.task_id
                   JOIN execution_workspace_claims w ON w.execution_id=e.execution_id
                   JOIN contexts c ON c.context_id=t.context_id
                   JOIN binding_snapshots b ON b.binding_snapshot_id=c.binding_snapshot_id
                   JOIN execution_recovery_stop_confirmations stopped ON stopped.execution_id=e.execution_id
                   WHERE t.scope=? AND t.task_id=? AND t.agent_id IN (${agentIds.map(() => "?").join(",")})`,
              )
              .get(scope, taskId, ...agentIds) as
              Record<string, unknown> | undefined);
      if (row === undefined) throwFailure("not_found", "task was not found");
      if (
        Number(row.revision) !== expectedRevision ||
        row.lifecycle_state !== "recovering" ||
        row.execution_lifecycle_state !== "recovering" ||
        row.recovery_resolution !== null ||
        row.claim_status !== "quarantined"
      ) {
        throwFailure(
          "operation_conflict",
          "interruption cannot be acknowledged",
          taskId,
        );
      }
      const reserve = db
        .prepare("SELECT * FROM task_reservations WHERE task_id=?")
        .get(taskId) as Record<string, unknown> | undefined;
      if (reserve === undefined || Number(reserve.control_receipts) < 1) {
        throwFailure("storage_capacity", "task control reserve is exhausted");
      }
      releaseBytes = Number(reserve.control_bytes);
      if (releaseBytes > 0) releasePhysicalControlReserve(releaseBytes);
      const revision = expectedRevision + 1;
      db.prepare(
        "UPDATE executions SET recovery_resolution='interrupted',accounting_phase='stopped',accounting_phase_started_at=NULL,revision=revision+1,updated_at=? WHERE execution_id=? AND lifecycle_state='recovering' AND recovery_resolution IS NULL",
      ).run(stamp, row.execution_id);
      db.prepare(
        "UPDATE tasks SET lifecycle_state='interrupted',input_state=NULL,reason='outcome_unknown',revision=?,updated_at=? WHERE task_id=? AND lifecycle_state='recovering' AND revision=?",
      ).run(revision, stamp, taskId, expectedRevision);
      db.prepare(
        "UPDATE execution_workspace_claims SET status='released',released_at=?,updated_at=? WHERE execution_id=? AND status='quarantined'",
      ).run(stamp, stamp, row.execution_id);
      const blocker = db
        .prepare(
          "INSERT INTO context_blockers(context_id,predecessor_task_id,state,created_at) VALUES(?,?,'interrupted',?) ON CONFLICT(context_id) DO UPDATE SET state=excluded.state,created_at=excluded.created_at WHERE context_blockers.predecessor_task_id=excluded.predecessor_task_id AND context_blockers.state='recovering'",
        )
        .run(row.context_id, taskId, stamp);
      if (blocker.changes === 1) {
        db.prepare(
          "UPDATE tasks SET state='paused',reason='predecessor_blocked',revision=revision+1,updated_at=? WHERE context_id=? AND state='queued' AND lifecycle_state IS NULL",
        ).run(stamp, row.context_id);
        db.prepare(
          "UPDATE contexts SET revision=revision+1,pause_reason='predecessor_blocked' WHERE context_id=?",
        ).run(row.context_id);
      }
      db.prepare(
        "UPDATE task_reservations SET control_receipts=control_receipts-1,control_bytes=0 WHERE task_id=?",
      ).run(taskId);
      emit(scope, taskId, revision, "interrupted", stamp);
      const resultTask = task(
        db.prepare("SELECT * FROM tasks WHERE task_id=?").get(taskId) as Record<
          string,
          unknown
        >,
      );
      db.prepare(
        "INSERT INTO operation_receipts(scope,operation_id,operation_type,target_id,fingerprint,actor_principal_id,result_json,created_at) VALUES(?,?, 'acknowledge_interruption',?,?,?,?,?)",
      ).run(
        scope,
        operationId,
        taskId,
        fingerprint,
        principalId,
        JSON.stringify({ taskId }),
        stamp,
      );
      changeCapacity("active_global", -1);
      changeCapacity(workspaceCapacityKey(String(row.workspace_id)), -1);
      if (releaseBytes > 0) {
        changeCapacity("reserved_control_bytes", -releaseBytes);
      }
      return { task: resultTask, replayed: false };
    });
    return result;
  } catch (error) {
    try {
      reconcilePhysicalControlReserve();
    } catch {
      throwFailure(
        "storage_unavailable",
        "physical control reserve reconciliation failed",
      );
    }
    throw error;
  }
}

function cancel(p: Record<string, unknown>) {
  const scope = String(p.accessScopeId);
  const operationId = String(p.operationId);
  const fingerprint = String(p.fingerprint);
  const taskId = String(p.taskId);
  const principalId = String(p.principalId);
  const activeElapsedMs = Number(p.activeElapsedMs ?? 0);
  if (!Number.isSafeInteger(activeElapsedMs) || activeElapsedMs < 0) {
    throwFailure(
      "operation_conflict",
      "execution accounting is invalid",
      taskId,
    );
  }
  checkpointWal();
  try {
    return registryFencedTransaction(p.expectedRegistryRevision, () => {
      const old = receipt(
        scope,
        operationId,
        "cancel",
        taskId,
        fingerprint,
        Array.isArray(p.allowedAgentIds)
          ? authorizedAgentIds(p.allowedAgentIds)
          : undefined,
      );
      if (old) return { task: old, replayed: true };
      const row = db
        .prepare(
          `SELECT t.*,b.workspace_id FROM tasks t JOIN contexts c ON c.context_id=t.context_id JOIN binding_snapshots b ON b.binding_snapshot_id=c.binding_snapshot_id WHERE t.scope=? AND t.task_id=? ${actualTables.has("task_expiry_markers") ? "AND NOT EXISTS (SELECT 1 FROM task_expiry_markers marker WHERE marker.task_id=t.task_id)" : ""}`,
        )
        .get(scope, taskId) as Record<string, unknown> | undefined;
      if (!row || !allowed(row.agent_id, p.allowedAgentIds))
        throwFailure("not_found", "task was not found");
      const execution = db
        .prepare(
          "SELECT execution_id,stop_reason,accounting_phase FROM executions WHERE task_id=?",
        )
        .get(taskId) as
        | {
            execution_id: string;
            stop_reason: string | null;
            accounting_phase: string;
          }
        | undefined;
      if (execution !== undefined) {
        if (execution.stop_reason === "completion") {
          throwFailure(
            "operation_conflict",
            "cancellation arrived after the completion candidate",
            taskId,
          );
        }
        const reserve = db
          .prepare("SELECT * FROM task_reservations WHERE task_id=?")
          .get(taskId) as Record<string, unknown> | undefined;
        if (
          !reserve ||
          Number(reserve.control_receipts) < 1 ||
          Number(reserve.control_events) < 1
        ) {
          throwFailure("storage_capacity", "task control reserve is exhausted");
        }
        const pausedControlReserveBytes =
          taskControlReserveBytes - Math.floor(taskControlReserveBytes / 2);
        const releaseBytes = Math.max(
          0,
          Number(reserve.control_bytes) - pausedControlReserveBytes,
        );
        if (releaseBytes > 0) releasePhysicalControlReserve(releaseBytes);
        requirePhysicalHeadroom(physicalCapacityBytes, 4 * pageSize);
        const revision = Number(row.revision) + 1;
        const stamp = typeof p.now === "string" ? p.now : now();
        db.prepare(
          "UPDATE executions SET lifecycle_state=CASE WHEN lifecycle_state IS NULL THEN NULL ELSE 'stopping' END,stop_reason=COALESCE(stop_reason,'cancellation'),stop_reason_committed_at=COALESCE(stop_reason_committed_at,?),accumulated_execution_ms=accumulated_execution_ms+CASE WHEN accounting_phase='active' THEN ? ELSE 0 END,accounting_phase='stopped',accounting_phase_started_at=NULL,revision=revision+1,updated_at=? WHERE execution_id=?",
        ).run(stamp, activeElapsedMs, stamp, execution.execution_id);
        db.prepare(
          "UPDATE tasks SET lifecycle_state=CASE WHEN lifecycle_state IS NULL THEN NULL ELSE 'stopping' END,input_state=NULL,reason='execution_stopping',revision=?,updated_at=? WHERE task_id=?",
        ).run(revision, stamp, taskId);
        db.prepare(
          "UPDATE questions SET state=CASE WHEN state='accepted' THEN 'closed' ELSE state END,closed_at=COALESCE(closed_at,?),closure_reason=COALESCE(closure_reason,'canceled'),delivery_state=CASE WHEN state='accepted' AND delivery_state='pending' THEN 'unknown' ELSE delivery_state END,delivery_unknown_at=CASE WHEN state='accepted' AND delivery_state='pending' THEN ? ELSE delivery_unknown_at END WHERE task_id=? AND closed_at IS NULL AND state IN ('pending','accepted')",
        ).run(stamp, stamp, taskId);
        db.prepare(
          "UPDATE task_reservations SET control_receipts=control_receipts-1,control_events=control_events-1,control_bytes=control_bytes-? WHERE task_id=?",
        ).run(releaseBytes, taskId);
        if (releaseBytes > 0) {
          changeCapacity("reserved_control_bytes", -releaseBytes);
        }
        emit(scope, taskId, revision, "cancel_requested", stamp);
        const result = task(
          db
            .prepare("SELECT * FROM tasks WHERE task_id=?")
            .get(taskId) as Record<string, unknown>,
        );
        maybeFail();
        db.prepare(
          "INSERT INTO operation_receipts(scope,operation_id,operation_type,target_id,fingerprint,actor_principal_id,result_json,created_at) VALUES(?,?, 'cancel',?,?,?,?,?)",
        ).run(
          scope,
          operationId,
          taskId,
          fingerprint,
          principalId,
          JSON.stringify({ taskId: result.taskId }),
          stamp,
        );
        requirePhysicalHeadroom(physicalCapacityBytes);
        return { task: result, replayed: false };
      }
      const expectedStates = Array.isArray(p.expectedStates)
        ? p.expectedStates.map(String)
        : [];
      if (!expectedStates.includes(String(row.state)))
        throwFailure(
          "invalid_state",
          "task cannot be canceled in its current state",
        );
      const reserve = db
        .prepare("SELECT * FROM task_reservations WHERE task_id=?")
        .get(taskId) as Record<string, unknown> | undefined;
      if (
        !reserve ||
        Number(reserve.control_receipts) < 1 ||
        Number(reserve.control_events) < 1
      )
        throwFailure("storage_capacity", "task control reserve is exhausted");
      releasePhysicalControlReserve(Number(reserve.control_bytes));
      requirePhysicalHeadroom(physicalCapacityBytes, 4 * pageSize);
      const revision = Number(row.revision) + 1;
      const stamp = typeof p.now === "string" ? p.now : now();
      db.prepare(
        "UPDATE tasks SET state=?, revision=?, updated_at=? WHERE task_id=?",
      ).run(String(p.nextState), revision, stamp, taskId);
      if (String(p.nextState) === "canceled") {
        const blocker = db
          .prepare(
            "INSERT INTO context_blockers(context_id,predecessor_task_id,state,created_at) VALUES(?,?, 'canceled',?) ON CONFLICT(context_id) DO NOTHING",
          )
          .run(row.context_id, taskId, stamp);
        if (blocker.changes === 1) {
          db.prepare(
            "UPDATE tasks SET state='paused',reason='predecessor_blocked',revision=revision+1,updated_at=? WHERE context_id=? AND state='queued'",
          ).run(stamp, row.context_id);
          db.prepare(
            "UPDATE contexts SET revision=revision+1,pause_reason='predecessor_blocked' WHERE context_id=?",
          ).run(row.context_id);
        }
      }
      db.prepare(
        "UPDATE task_reservations SET control_receipts=control_receipts-1, control_events=control_events-1 WHERE task_id=?",
      ).run(taskId);
      emit(scope, taskId, revision, String(p.eventType), stamp);
      const result = task(
        db.prepare("SELECT * FROM tasks WHERE task_id=?").get(taskId) as Record<
          string,
          unknown
        >,
      );
      maybeFail();
      db.prepare(
        "INSERT INTO operation_receipts(scope,operation_id,operation_type,target_id,fingerprint,actor_principal_id,result_json,created_at) VALUES(?,?, 'cancel',?,?,?,?,?)",
      ).run(
        scope,
        operationId,
        taskId,
        fingerprint,
        principalId,
        JSON.stringify({ taskId: result.taskId }),
        stamp,
      );
      changeCapacity("active_global", -1);
      changeCapacity(workspaceCapacityKey(String(row.workspace_id)), -1);
      changeCapacity("reserved_control_bytes", -Number(reserve.control_bytes));
      db.prepare(
        "UPDATE task_reservations SET control_bytes=0 WHERE task_id=?",
      ).run(taskId);
      requirePhysicalHeadroom(physicalCapacityBytes);
      return { task: result, replayed: false };
    });
  } catch (error) {
    try {
      reconcilePhysicalControlReserve();
    } catch {
      throwFailure(
        "storage_unavailable",
        "physical control reserve reconciliation failed",
      );
    }
    throw error;
  }
}
function allowed(agentId: unknown, values: unknown): boolean {
  return !Array.isArray(values) || values.includes(agentId);
}
function authorizedAgentIds(values: unknown): string[] {
  return Array.isArray(values) ? values.map(String) : [];
}

function expiredTaskMarker(
  scope: string,
  taskId: string,
  agentIds: readonly string[],
): Record<string, unknown> | undefined {
  if (agentIds.length === 0 || !actualTables.has("task_expiry_markers")) {
    return undefined;
  }
  return db
    .prepare(
      `SELECT * FROM task_expiry_markers
       WHERE scope=? AND task_id=?
         AND agent_id IN (${agentIds.map(() => "?").join(",")})`,
    )
    .get(scope, taskId, ...agentIds) as Record<string, unknown> | undefined;
}

function retentionSequence(
  scope: string,
  agentIds: readonly string[],
  filters: { agentId?: string; state?: string; taskId?: string } = {},
): number {
  if (agentIds.length === 0 || !actualTables.has("task_expiry_markers")) {
    return 0;
  }
  const clauses = [
    "scope=?",
    `agent_id IN (${agentIds.map(() => "?").join(",")})`,
  ];
  const parameters: unknown[] = [scope, ...agentIds];
  if (filters.agentId !== undefined) {
    clauses.push("agent_id=?");
    parameters.push(filters.agentId);
  }
  if (filters.state !== undefined) {
    clauses.push("terminal_state=?");
    parameters.push(filters.state);
  }
  if (filters.taskId !== undefined) {
    clauses.push("task_id=?");
    parameters.push(filters.taskId);
  }
  return Number(
    (
      db
        .prepare(
          `SELECT COALESCE(MAX(expiry_sequence),0) AS value
           FROM task_expiry_markers WHERE ${clauses.join(" AND ")}`,
        )
        .get(...parameters) as { value: number }
    ).value,
  );
}

function expireRetainedData(p: Record<string, unknown>) {
  requireWritableLifecycle();
  const asOf = String(p.asOf);
  const parsedAsOf = Date.parse(asOf);
  const batchLimit = Number(p.batchLimit ?? 50);
  if (
    !Number.isFinite(parsedAsOf) ||
    new Date(parsedAsOf).toISOString() !== asOf ||
    !Number.isSafeInteger(batchLimit) ||
    batchLimit < 1 ||
    batchLimit > 100
  ) {
    throwFailure("operation_conflict", "retention request is invalid");
  }
  const cutoff = new Date(
    parsedAsOf - terminalRetentionMilliseconds,
  ).toISOString();
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT t.task_id,t.scope,t.agent_id,t.context_id,t.queue_order,
                e.execution_id,
                COALESCE(terminal.terminal_state,t.lifecycle_state,t.state) AS terminal_state,
                COALESCE(terminal.committed_at,t.updated_at) AS terminal_committed_at,
                COALESCE((SELECT MAX(event.cursor) FROM task_events event WHERE event.task_id=t.task_id),0) AS max_event_cursor,
                LENGTH(CAST(t.instruction AS BLOB)) AS instruction_bytes
         FROM tasks t
         LEFT JOIN executions e ON e.task_id=t.task_id
         LEFT JOIN execution_terminals terminal ON terminal.execution_id=e.execution_id
         LEFT JOIN execution_workspace_claims claim ON claim.execution_id=e.execution_id
         WHERE NOT EXISTS (
                 SELECT 1 FROM task_expiry_markers marker
                 WHERE marker.task_id=t.task_id
               )
           AND COALESCE(terminal.terminal_state,t.lifecycle_state,t.state)
                 IN ('completed','failed','canceled','interrupted')
           AND COALESCE(terminal.committed_at,t.updated_at)<=?
           AND COALESCE(claim.status,'released') NOT IN ('held','quarantined')
         ORDER BY terminal_committed_at,t.queue_order,t.task_id
         LIMIT ?`,
      )
      .all(cutoff, batchLimit) as Record<string, unknown>[];
    let receiptsTombstoned = 0;
    let eventsExpired = 0;
    let admissionBytesReleased = 0;

    for (const row of rows) {
      const taskId = String(row.task_id);
      const contextId = String(row.context_id);
      const executionId =
        typeof row.execution_id === "string" ? row.execution_id : undefined;
      db.prepare(
        "INSERT INTO task_expiry_markers(task_id,scope,agent_id,context_id,queue_order,terminal_state,terminal_committed_at,expired_at,max_event_cursor) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        taskId,
        row.scope,
        row.agent_id,
        contextId,
        row.queue_order,
        row.terminal_state,
        row.terminal_committed_at,
        asOf,
        row.max_event_cursor,
      );
      receiptsTombstoned += db
        .prepare(
          "UPDATE operation_receipts SET result_json=json_object('taskId',retained_task_id),expired_at=? WHERE retained_task_id=? AND expired_at IS NULL",
        )
        .run(asOf, taskId).changes;
      eventsExpired += Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM task_events WHERE task_id=?",
            )
            .get(taskId) as { count: number }
        ).count,
      );
      admissionBytesReleased += Number(row.instruction_bytes ?? 0);

      db.prepare("DELETE FROM questions WHERE task_id=?").run(taskId);
      db.prepare("DELETE FROM task_events WHERE task_id=?").run(taskId);
      db.prepare("DELETE FROM task_workspace_queue WHERE task_id=?").run(
        taskId,
      );
      db.prepare("DELETE FROM task_reservations WHERE task_id=?").run(taskId);
      db.prepare(
        "UPDATE tasks SET created_by='',instruction='',reason=NULL,input_state=NULL WHERE task_id=?",
      ).run(taskId);

      if (executionId !== undefined) {
        db.prepare(
          "DELETE FROM execution_observations WHERE execution_id=?",
        ).run(executionId);
        db.prepare(
          "UPDATE execution_terminals SET result_json=NULL WHERE execution_id=?",
        ).run(executionId);
        const executionStillRequired =
          db
            .prepare(
              `SELECT 1
               WHERE EXISTS (
                 SELECT 1 FROM runtime_session_tokens
                 WHERE source_execution_id=?
               ) OR EXISTS (
                 SELECT 1 FROM context_continuations
                 WHERE consumed_by_execution_id=?
               )`,
            )
            .get(executionId, executionId) !== undefined;
        if (!executionStillRequired) {
          db.prepare(
            "DELETE FROM execution_recovery_stop_confirmations WHERE execution_id=?",
          ).run(executionId);
          db.prepare(
            "DELETE FROM execution_terminals WHERE execution_id=?",
          ).run(executionId);
          db.prepare(
            "DELETE FROM execution_workspace_claims WHERE execution_id=?",
          ).run(executionId);
          db.prepare("DELETE FROM workspace_claims WHERE execution_id=?").run(
            executionId,
          );
          db.prepare("DELETE FROM executions WHERE execution_id=?").run(
            executionId,
          );
        }
      }

      const structuralTaskStillRequired =
        db
          .prepare(
            `SELECT 1
             WHERE EXISTS (
               SELECT 1 FROM tasks WHERE predecessor_task_id=?
             ) OR EXISTS (
               SELECT 1 FROM context_blockers WHERE predecessor_task_id=?
             ) OR EXISTS (
               SELECT 1 FROM context_continuations WHERE target_task_id=?
             ) OR EXISTS (
               SELECT 1 FROM executions WHERE task_id=?
             )`,
          )
          .get(taskId, taskId, taskId, taskId) !== undefined;
      if (!structuralTaskStillRequired) {
        db.prepare("DELETE FROM tasks WHERE task_id=?").run(taskId);
      }
    }

    const retiredContexts = db
      .prepare(
        `SELECT c.context_id
         FROM contexts c
         WHERE EXISTS (
                 SELECT 1 FROM task_expiry_markers marker
                 WHERE marker.context_id=c.context_id
               )
           AND NOT EXISTS (
                 SELECT 1 FROM tasks t
                 WHERE t.context_id=c.context_id
                   AND NOT EXISTS (
                     SELECT 1 FROM task_expiry_markers marker
                     WHERE marker.task_id=t.task_id
                   )
               )`,
      )
      .all() as { context_id: string }[];
    for (const { context_id: contextId } of retiredContexts) {
      const bindingIds = (
        db
          .prepare(
            `SELECT binding_snapshot_id AS id FROM contexts WHERE context_id=?
             UNION
             SELECT e.binding_snapshot_id AS id FROM executions e JOIN tasks t ON t.task_id=e.task_id WHERE t.context_id=?
             UNION
             SELECT token.binding_snapshot_id AS id FROM runtime_session_tokens token WHERE token.context_id=?`,
          )
          .all(contextId, contextId, contextId) as { id: string }[]
      ).map(({ id }) => id);
      db.prepare("DELETE FROM context_continuations WHERE context_id=?").run(
        contextId,
      );
      db.prepare("DELETE FROM context_blockers WHERE context_id=?").run(
        contextId,
      );
      db.prepare("DELETE FROM runtime_session_tokens WHERE context_id=?").run(
        contextId,
      );
      db.prepare(
        "DELETE FROM execution_recovery_stop_confirmations WHERE execution_id IN (SELECT e.execution_id FROM executions e JOIN tasks t ON t.task_id=e.task_id WHERE t.context_id=?)",
      ).run(contextId);
      db.prepare(
        "DELETE FROM execution_terminals WHERE execution_id IN (SELECT e.execution_id FROM executions e JOIN tasks t ON t.task_id=e.task_id WHERE t.context_id=?)",
      ).run(contextId);
      db.prepare(
        "DELETE FROM execution_observations WHERE execution_id IN (SELECT e.execution_id FROM executions e JOIN tasks t ON t.task_id=e.task_id WHERE t.context_id=?)",
      ).run(contextId);
      db.prepare(
        "DELETE FROM execution_workspace_claims WHERE execution_id IN (SELECT e.execution_id FROM executions e JOIN tasks t ON t.task_id=e.task_id WHERE t.context_id=?)",
      ).run(contextId);
      db.prepare(
        "DELETE FROM workspace_claims WHERE execution_id IN (SELECT e.execution_id FROM executions e JOIN tasks t ON t.task_id=e.task_id WHERE t.context_id=?)",
      ).run(contextId);
      db.prepare(
        "DELETE FROM executions WHERE task_id IN (SELECT task_id FROM tasks WHERE context_id=?)",
      ).run(contextId);
      db.prepare("DELETE FROM tasks WHERE context_id=?").run(contextId);
      db.prepare("DELETE FROM contexts WHERE context_id=?").run(contextId);
      for (const bindingId of bindingIds) {
        db.prepare(
          `DELETE FROM binding_snapshots
           WHERE binding_snapshot_id=?
             AND NOT EXISTS (SELECT 1 FROM contexts WHERE binding_snapshot_id=?)
             AND NOT EXISTS (SELECT 1 FROM executions WHERE binding_snapshot_id=?
             )
             AND NOT EXISTS (SELECT 1 FROM runtime_session_tokens WHERE binding_snapshot_id=?)`,
        ).run(bindingId, bindingId, bindingId, bindingId);
      }
    }
    if (admissionBytesReleased > 0) {
      changeCapacity("admission_bytes", -admissionBytesReleased);
    }
    maybeFail();
    waitAtTestCommitBarrier();
    return {
      contextsExpired: retiredContexts.length,
      tasksExpired: rows.length,
      receiptsTombstoned,
      eventsExpired,
      asOf,
      cutoff,
    };
  })();
}
parentPort?.on("message", (message: Request) => {
  try {
    let result: unknown;
    const p = message.payload;
    const scope = String(p.accessScopeId);
    if (message.command === "ready") result = undefined;
    else if (message.command === "installRegistryRevision") {
      const revision = Number(p.revision);
      if (
        !Number.isSafeInteger(revision) ||
        revision !== Atomics.load(registryRevisionFence, 0)
      ) {
        throw new Error("invalid Registry revision fence");
      }
      if (p.persist === true) {
        const fingerprint = p.fingerprint;
        if (
          typeof fingerprint !== "string" ||
          !/^sha256:v1:[0-9a-f]{64}$/u.test(fingerprint)
        ) {
          throw new Error("invalid Registry fingerprint");
        }
        const stored = db
          .prepare("SELECT key,value FROM store_metadata WHERE key IN (?,?)")
          .all("registry_revision", "registry_fingerprint") as {
          key: string;
          value: string;
        }[];
        const metadata = new Map(
          stored.map(({ key, value }) => [key, value] as const),
        );
        const storedRevision = Number(metadata.get("registry_revision") ?? 0);
        const storedFingerprint = metadata.get("registry_fingerprint");
        if (
          !Number.isSafeInteger(storedRevision) ||
          storedRevision < 0 ||
          revision < storedRevision ||
          (revision === storedRevision &&
            storedRevision > 0 &&
            storedFingerprint !== fingerprint)
        ) {
          throw new Error("Registry revision candidate is stale");
        }
        db.transaction(() => {
          db.prepare(
            "INSERT INTO store_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          ).run("registry_revision", String(revision));
          db.prepare(
            "INSERT INTO store_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          ).run("registry_fingerprint", fingerprint);
        })();
      }
      result = undefined;
    } else if (message.command === "transitionTasks") {
      transitionTasks(p);
      result = undefined;
    } else if (message.command === "recordAudit") {
      recordAudit(p);
      result = undefined;
    } else if (message.command === "recordAuditGap") {
      recordAuditGap(p);
      result = undefined;
    } else if (message.command === "expireRetainedData") {
      result = expireRetainedData(p);
    } else if (message.command === "lookupReceipt")
      result = receipt(
        scope,
        String(p.operationId),
        String(p.operationType),
        typeof p.targetId === "string" ? p.targetId : null,
        String(p.fingerprint),
        authorizedAgentIds(p.allowedAgentIds),
        typeof p.expectedAgentId === "string" ? p.expectedAgentId : undefined,
      );
    else if (message.command === "submit") {
      requireWritableLifecycle();
      result = submit(p);
    } else if (message.command === "edit") {
      requireWritableLifecycle();
      result = edit(p);
    } else if (message.command === "resumeContext") {
      requireWritableLifecycle();
      result = resumeContext(p);
    } else if (message.command === "confirmRecoveryStopped") {
      requireWritableLifecycle();
      confirmRecoveryStopped(p);
      result = undefined;
    } else if (message.command === "acknowledgeInterruption") {
      requireWritableLifecycle();
      result = acknowledgeInterruption(p);
    } else if (message.command === "persistQuestionObservation") {
      requireWritableLifecycle();
      result = persistQuestionObservation(p);
    } else if (message.command === "replyToQuestion") {
      requireWritableLifecycle();
      result = replyToQuestion(p);
    } else if (message.command === "getQuestionForDelivery") {
      result = getQuestionForDelivery(p);
    } else if (message.command === "markQuestionDeliveryUnknown") {
      requireWritableLifecycle();
      markQuestionDeliveryUnknown(p);
      result = undefined;
    } else if (message.command === "acknowledgeQuestionDelivery") {
      requireWritableLifecycle();
      result = acknowledgeQuestionDelivery(p);
    } else if (message.command === "cancel") result = cancel(p);
    else if (message.command === "claimAndPrepare") {
      requireWritableLifecycle();
      result = claimAndPrepare(p);
    } else if (message.command === "getTaskForDispatch") {
      const row = db
        .prepare(
          `SELECT * FROM tasks WHERE task_id=? ${actualTables.has("task_expiry_markers") ? "AND NOT EXISTS (SELECT 1 FROM task_expiry_markers marker WHERE marker.task_id=tasks.task_id)" : ""}`,
        )
        .get(String(p.taskId)) as Record<string, unknown> | undefined;
      result = row === undefined ? undefined : task(row);
    } else if (message.command === "listEligibleContextHeads") {
      result = eligibleContextHeads(
        scope,
        authorizedAgentIds(p.allowedAgentIds),
        Number(p.limit),
      ).map(task);
    } else if (message.command === "getEligibleTasksForDispatch") {
      result = eligibleContextHeads(
        scope,
        authorizedAgentIds(p.allowedAgentIds),
        Number(p.limit),
      ).map(task);
    } else if (message.command === "markExecutionRunning") {
      requireWritableLifecycle();
      result = markExecutionRunning(p);
    } else if (message.command === "quarantineExecutionForDispatch") {
      requireWritableLifecycle();
      result = quarantineExecutionForDispatch(p);
    } else if (message.command === "interruptExecution") {
      requireWritableLifecycle();
      result = interruptExecution(p);
    } else if (message.command === "commitExecutionObservation") {
      requireWritableLifecycle();
      result = commitExecutionObservation(p);
    } else if (message.command === "commitRuntimeObservation") {
      requireWritableLifecycle();
      result = commitRuntimeObservation(p);
    } else if (message.command === "commitTerminal") {
      requireWritableLifecycle();
      result = commitTerminal(p);
    } else if (message.command === "recoverExecutions") {
      result = recoverExecutions(p);
    } else if (message.command === "quarantineExecution") {
      result = quarantineExecution(p);
    } else if (message.command === "getExecution") {
      const agentIds = authorizedAgentIds(p.allowedAgentIds);
      const row = db
        .prepare(
          `SELECT e.*,w.status AS claim_status FROM executions e JOIN tasks t ON t.task_id=e.task_id LEFT JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE t.scope=? AND e.task_id=? AND t.agent_id IN (${agentIds.map(() => "?").join(",")}) ${actualTables.has("task_expiry_markers") ? "AND NOT EXISTS (SELECT 1 FROM task_expiry_markers marker WHERE marker.task_id=t.task_id)" : ""}`,
        )
        .get(scope, String(p.taskId), ...agentIds) as
        Record<string, unknown> | undefined;
      result = row === undefined ? undefined : execution(row);
    } else if (message.command === "getTaskProjection") {
      const agentIds = authorizedAgentIds(p.allowedAgentIds);
      const marker = expiredTaskMarker(scope, String(p.taskId), agentIds);
      if (marker !== undefined) {
        throwFailure(
          "result_expired",
          "retained Task result has expired",
          String(p.taskId),
        );
      }
      const taskRow =
        agentIds.length === 0
          ? undefined
          : (db
              .prepare(
                `SELECT * FROM tasks WHERE scope=? AND task_id=? AND agent_id IN (${agentIds.map(() => "?").join(",")})`,
              )
              .get(scope, String(p.taskId), ...agentIds) as
              Record<string, unknown> | undefined);
      if (taskRow === undefined) result = undefined;
      else {
        const executionRow = db
          .prepare(
            "SELECT e.*,w.status AS claim_status FROM executions e LEFT JOIN execution_workspace_claims w ON w.execution_id=e.execution_id WHERE e.task_id=?",
          )
          .get(String(p.taskId)) as Record<string, unknown> | undefined;
        result = {
          task: task(taskRow),
          execution:
            executionRow === undefined ? null : execution(executionRow),
          question: (() => {
            const questionRow = questionForTask(String(p.taskId));
            return questionRow === undefined ? null : question(questionRow);
          })(),
        };
      }
    } else if (message.command === "get") {
      const agentIds = authorizedAgentIds(p.allowedAgentIds);
      const marker = expiredTaskMarker(scope, String(p.taskId), agentIds);
      if (marker !== undefined) {
        throwFailure(
          "result_expired",
          "retained Task result has expired",
          String(p.taskId),
        );
      }
      const r = db
        .prepare("SELECT * FROM tasks WHERE scope=? AND task_id=?")
        .get(scope, String(p.taskId)) as Record<string, unknown> | undefined;
      result =
        r && allowed(r.agent_id, p.allowedAgentIds) ? task(r) : undefined;
    } else if (message.command === "list") {
      if (failNextReadDiagnostic) {
        failNextReadDiagnostic = false;
        throw new Error(nextReadDiagnosticMarker);
      }
      const agentIds = authorizedAgentIds(p.allowedAgentIds);
      const currentRetentionSequence = retentionSequence(scope, agentIds, {
        ...(typeof p.agentId === "string" ? { agentId: p.agentId } : {}),
        ...(typeof p.state === "string" ? { state: p.state } : {}),
      });
      if (
        p.afterQueueOrder !== undefined &&
        Number(p.retentionSequence ?? -1) < currentRetentionSequence
      ) {
        const expiredAfterCursor = db
          .prepare(
            `SELECT 1 FROM task_expiry_markers
             WHERE scope=?
               AND agent_id IN (${agentIds.map(() => "?").join(",")})
               AND expiry_sequence>? AND queue_order>?
               ${typeof p.agentId === "string" ? "AND agent_id=?" : ""}
               ${typeof p.state === "string" ? "AND terminal_state=?" : ""}
             LIMIT 1`,
          )
          .get(
            scope,
            ...agentIds,
            Number(p.retentionSequence ?? -1),
            Number(p.afterQueueOrder),
            ...(typeof p.agentId === "string" ? [p.agentId] : []),
            ...(typeof p.state === "string" ? [p.state] : []),
          );
        if (expiredAfterCursor !== undefined) {
          throwFailure("cursor_expired", "Task list cursor has expired");
        }
      }
      const filters = [
        "scope=?",
        `agent_id IN (${agentIds.map(() => "?").join(",")})`,
        "queue_order>?",
      ];
      if (actualTables.has("task_expiry_markers")) {
        filters.push(
          "NOT EXISTS (SELECT 1 FROM task_expiry_markers marker WHERE marker.task_id=tasks.task_id)",
        );
      }
      const parameters: unknown[] = [
        scope,
        ...agentIds,
        Number(p.afterQueueOrder ?? 0),
      ];
      if (typeof p.agentId === "string") {
        filters.push("agent_id=?");
        parameters.push(p.agentId);
      }
      if (typeof p.state === "string") {
        filters.push("COALESCE(input_state,lifecycle_state,state)=?");
        parameters.push(p.state);
      }
      parameters.push(Number(p.limit));
      const rows =
        agentIds.length === 0
          ? []
          : (db
              .prepare(
                `SELECT * FROM tasks WHERE ${filters.join(" AND ")} ORDER BY queue_order LIMIT ?`,
              )
              .all(...parameters) as Record<string, unknown>[]);
      const tasks = rows.map(task);
      result = {
        tasks,
        lastQueueOrder: tasks.at(-1)?.queueOrder,
        retentionSequence: currentRetentionSequence,
      };
    } else if (message.command === "events") {
      const agentIds = authorizedAgentIds(p.allowedAgentIds);
      if (typeof p.taskId === "string") {
        const marker = expiredTaskMarker(scope, p.taskId, agentIds);
        if (marker !== undefined) {
          throwFailure(
            p.afterCursor === undefined ? "result_expired" : "cursor_expired",
            "retained Task event history has expired",
            p.taskId,
          );
        }
        const currentTask =
          agentIds.length === 0
            ? undefined
            : db
                .prepare(
                  `SELECT 1 FROM tasks WHERE scope=? AND task_id=?
                   AND agent_id IN (${agentIds.map(() => "?").join(",")})`,
                )
                .get(scope, p.taskId, ...agentIds);
        if (currentTask === undefined) {
          throwFailure("not_found", "Task was not found");
        }
      }
      const currentRetentionSequence = retentionSequence(scope, agentIds, {
        ...(typeof p.taskId === "string" ? { taskId: p.taskId } : {}),
      });
      if (
        p.afterCursor !== undefined &&
        Number(p.retentionSequence ?? -1) < currentRetentionSequence
      ) {
        const expiredAfterCursor = db
          .prepare(
            `SELECT 1 FROM task_expiry_markers
             WHERE scope=?
               AND agent_id IN (${agentIds.map(() => "?").join(",")})
               AND expiry_sequence>? AND max_event_cursor>?
               ${typeof p.taskId === "string" ? "AND task_id=?" : ""}
             LIMIT 1`,
          )
          .get(
            scope,
            ...agentIds,
            Number(p.retentionSequence ?? -1),
            Number(p.afterCursor),
            ...(typeof p.taskId === "string" ? [p.taskId] : []),
          );
        if (expiredAfterCursor !== undefined) {
          throwFailure("cursor_expired", "event cursor has expired");
        }
      }
      const filters = [
        "e.scope=?",
        "e.cursor>?",
        `t.agent_id IN (${agentIds.map(() => "?").join(",")})`,
      ];
      const parameters: unknown[] = [
        scope,
        Number(p.afterCursor ?? 0),
        ...agentIds,
      ];
      if (typeof p.taskId === "string") {
        filters.push("e.task_id=?");
        parameters.push(p.taskId);
      }
      parameters.push(Number(p.limit));
      const rows =
        agentIds.length === 0
          ? []
          : (db
              .prepare(
                `SELECT e.cursor,e.scope,e.task_id,e.task_sequence,e.revision,e.event_type,e.created_at,t.agent_id FROM task_events e JOIN tasks t ON t.task_id=e.task_id AND t.scope=e.scope WHERE ${filters.join(" AND ")} ORDER BY e.cursor LIMIT ?`,
              )
              .all(...parameters) as Record<string, unknown>[]);
      const events = rows.map((r) => ({
        cursor: r.cursor,
        taskId: r.task_id,
        taskSeq: r.task_sequence,
        agentId: r.agent_id,
        type: r.event_type,
        taskRevision: r.revision,
        occurredAt: r.created_at,
      }));
      result = {
        events,
        lastCursor: events.at(-1)?.cursor,
        retentionSequence: currentRetentionSequence,
      };
    } else if (message.command === "probe") {
      if (p.probe === "failNextCommit") failNextCommit = true;
      else if (p.probe === "failNextStorageBusy") failNextStorageBusy = true;
      else if (p.probe === "failNextStorageFull") failNextStorageFull = true;
      else if (p.probe === "failNextStorageIo") failNextStorageIo = true;
      else if (p.probe === "failNextReadDiagnostic") {
        nextReadDiagnosticMarker = "AP014-PRIVATE-DIAGNOSTIC-MARKER";
        failNextReadDiagnostic = true;
      } else if (p.probe === "failNextAp015ReadDiagnostic") {
        nextReadDiagnosticMarker = "AP015-PRIVATE-DIAGNOSTIC-MARKER";
        failNextReadDiagnostic = true;
      } else if (p.probe === "failNextAuditGap") failNextAuditGap = true;
      else if (p.probe === "failAuditGapPermanently")
        failAuditGapPermanently = true;
      else if (p.probe === "setFutureSchemaVersion")
        db.prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES(999, ?)",
        ).run(now());
      else if (p.probe === "makeSchemaIncomplete")
        db.exec("DROP TABLE task_reservations");
      else if (p.probe === "exhaustRestartEventReserve")
        db.prepare("UPDATE task_reservations SET control_events=0").run();
      else if (p.probe === "corruptReservedControlSummary")
        db.prepare(
          "UPDATE capacity_metadata SET value=0 WHERE key='reserved_control_bytes'",
        ).run();
      else if (p.probe === "zeroTaskReservationLedger")
        db.prepare("UPDATE task_reservations SET control_bytes=0").run();
      else if (p.probe === "underfundTaskReservationLedger")
        db.prepare("UPDATE task_reservations SET control_bytes=1").run();
      else if (p.probe === "underfundTaskEventLedger")
        db.prepare("UPDATE task_reservations SET control_events=1").run();
      else if (p.probe === "inspectDurability")
        result = {
          bindingSnapshots: (
            db
              .prepare("SELECT COUNT(*) AS count FROM binding_snapshots")
              .get() as {
              count: number;
            }
          ).count,
          contexts: (
            db.prepare("SELECT COUNT(*) AS count FROM contexts").get() as {
              count: number;
            }
          ).count,
          bindingPayloads: (
            db
              .prepare(
                "SELECT payload_json AS payload FROM binding_snapshots ORDER BY binding_snapshot_id",
              )
              .all() as { payload: string }[]
          ).map(({ payload }) => {
            const parsed: unknown = JSON.parse(payload);
            return parsed;
          }),
          receipts: (
            db
              .prepare("SELECT COUNT(*) AS count FROM operation_receipts")
              .get() as {
              count: number;
            }
          ).count,
          actors: (
            db
              .prepare(
                "SELECT actor_principal_id AS actor FROM operation_receipts ORDER BY operation_id",
              )
              .all() as { actor: string }[]
          ).map(({ actor }) => actor),
          reservations: (
            db
              .prepare("SELECT COUNT(*) AS count FROM task_reservations")
              .get() as {
              count: number;
            }
          ).count,
          reservationState: db
            .prepare(
              "SELECT control_receipts AS controlReceipts,control_events AS controlEvents,control_bytes AS controlBytes FROM task_reservations ORDER BY task_id",
            )
            .all(),
          capacity: db
            .prepare("SELECT key,value FROM capacity_metadata ORDER BY key")
            .all(),
        };
      else if (p.probe === "inspectPhysicalCapacity")
        result = {
          ...physicalUsage(),
          pageCount: Number(db.pragma("page_count", { simple: true })),
          freelistCount: Number(db.pragma("freelist_count", { simple: true })),
          availableFilesystemBytes: availableFilesystemBytes(),
          pageSize,
          physicalAdmissionBytes,
          physicalControlReserveBytes,
          physicalCapacityBytes,
          reservedControlBytes: capacityValue("reserved_control_bytes"),
        };
      else if (p.probe === "inspectProductAudit")
        result = {
          records: (
            db
              .prepare(
                "SELECT sequence,principal_id AS principalId,method,tool_name AS toolName,protocol_version AS protocolVersion,client_name AS clientName,client_version AS clientVersion,client_capabilities_json AS clientCapabilitiesJson,result_code AS resultCode,created_at AS createdAt FROM product_audit_records ORDER BY sequence",
              )
              .all() as Record<string, unknown>[]
          ).map((record) => ({ ...record })),
          overwrittenCount: Number(
            (
              db
                .prepare(
                  "SELECT overwritten_count AS count FROM product_audit_state WHERE singleton=1",
                )
                .get() as { count: number }
            ).count,
          ),
        };
      else if (p.probe === "inspectProtectedSessionTokens")
        result = (
          db
            .prepare(
              "SELECT session_reference AS sessionReference,source_execution_id AS sourceExecutionId,context_id AS contextId,state,LENGTH(ciphertext) AS ciphertextBytes,LENGTH(nonce) AS nonceBytes,LENGTH(auth_tag) AS authTagBytes,key_id AS keyId FROM runtime_session_tokens ORDER BY session_reference",
            )
            .all() as Record<string, unknown>[]
        ).map((token) => ({ ...token }));
      else if (p.probe === "truncatePhysicalControlReserve")
        resizePhysicalControlReserve(0);
      else if (p.probe === "exitClean") {
        closeSync(controlReserveFile);
        db.close();
        parentPort?.close();
        return;
      } else if (p.probe === "block")
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          Number(p.milliseconds),
        );
      else if (p.probe === "largeRead")
        result = "x".repeat(Math.min(Number(p.milliseconds) || 0, 1024 * 1024));
      else if (p.probe === "inspectSchemaVersions") {
        result = (
          db
            .prepare("SELECT version FROM schema_migrations ORDER BY version")
            .all() as { version: number }[]
        ).map(({ version }) => version);
      }
    } else if (message.command === "close") {
      closeSync(controlReserveFile);
      db.close();
      parentPort?.postMessage({ requestId: message.requestId, result });
      parentPort?.close();
      return;
    } else throw new Error("unknown storage command");
    parentPort?.postMessage({ requestId: message.requestId, result });
  } catch (error: unknown) {
    const candidate = error as { storageFailure?: Failure };
    const sqliteCode = (error as { code?: unknown }).code;
    const failure =
      candidate.storageFailure ??
      (sqliteCode === "SQLITE_FULL"
        ? {
            code: "storage_unavailable" as const,
            message: "physical storage capacity is exhausted",
            incident: true,
          }
        : {
            code: "storage_unavailable" as const,
            message: "storage operation failed",
            incident: true,
          });
    parentPort?.postMessage({ requestId: message.requestId, failure });
  }
});
