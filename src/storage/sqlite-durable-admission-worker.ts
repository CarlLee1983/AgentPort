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
import {
  executionControlMigration,
  executionControlRollbackMigration,
  initialMigration,
} from "./migration.js";

/* The binding's synchronous query API is intentionally confined to this worker.
 * Its declarations expose row values as any, so conversion happens only here. */
/* eslint-disable @typescript-eslint/no-unnecessary-type-conversion */

interface Options {
  databasePath: string;
  auditCapacity?: number;
  queuePerWorkspace?: number;
  queueGlobal?: number;
  receiptCapacity?: number;
  admissionBytes?: number;
  physicalAdmissionBytes?: number;
  physicalControlReserveBytes?: number;
  taskControlReserveBytes?: number;
  controlReceiptReserve?: number;
  controlEventReserve?: number;
  busyTimeoutMs?: number;
  registryRevisionFence: SharedArrayBuffer;
  testCommitBarrier: SharedArrayBuffer;
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
    | "not_found";
  message: string;
  taskId?: string;
}
const options = workerData as Options;
const registryRevisionFence = new Int32Array(options.registryRevisionFence);
const testCommitBarrier = new Int32Array(options.testCommitBarrier);
const physicalAdmissionBytes =
  options.physicalAdmissionBytes ?? 2 * 1024 * 1024 * 1024;
const physicalControlReserveBytes =
  options.physicalControlReserveBytes ?? 256 * 1024 * 1024;
const physicalCapacityBytes =
  physicalAdmissionBytes + physicalControlReserveBytes;
const taskControlReserveBytes = options.taskControlReserveBytes ?? 128 * 1024;
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
    })();
  } else if (
    versions.length !== 2 ||
    Number(versions[0]?.version) !== 1 ||
    Number(versions[1]?.version) !== 2
  ) {
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
  })();
}

const requiredTables = [
  "binding_snapshots",
  "capacity_metadata",
  "contexts",
  "executions",
  "operation_receipts",
  "product_audit_records",
  "product_audit_state",
  "schema_migrations",
  "store_metadata",
  "task_events",
  "task_reservations",
  "tasks",
  "workspace_claims",
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
const receiptColumns = new Set(
  (db.pragma("table_info(operation_receipts)") as { name: string }[]).map(
    ({ name }) => name,
  ),
);
if (!receiptColumns.has("actor_principal_id")) {
  throw new Error("durable admission receipt schema is incompatible");
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
function requirePhysicalHeadroom(
  boundary: number,
  estimatedGrowth = 0,
  filesystemReserve = 0,
): void {
  const usage = physicalUsage();
  if (
    usage.accountedDatabaseAndWalBytes + estimatedGrowth > boundary ||
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
    throw new Error("injected product audit gap failure");
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
  const invalidReservation = db
    .prepare(
      "SELECT t.task_id FROM tasks t LEFT JOIN task_reservations r ON r.task_id=t.task_id WHERE t.state IN ('queued','paused') AND (r.task_id IS NULL OR r.control_receipts<1 OR r.control_bytes < CASE t.state WHEN 'queued' THEN ? ELSE ? END OR r.control_events < CASE t.state WHEN 'queued' THEN 2 ELSE 1 END) LIMIT 1",
    )
    .get(taskControlReserveBytes, pausedControlReserveBytes) as
    { task_id: string } | undefined;
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
            "SELECT COUNT(*) AS value FROM operation_receipts WHERE operation_type='submit'",
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
            "SELECT COUNT(*) AS value FROM tasks WHERE state IN ('queued','paused')",
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
        "SELECT b.workspace_id AS workspace_id, COUNT(*) AS value FROM tasks t JOIN contexts c ON c.context_id=t.context_id JOIN binding_snapshots b ON b.binding_snapshot_id=c.binding_snapshot_id WHERE t.state IN ('queued','paused') GROUP BY b.workspace_id",
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
  return {
    taskId: row.task_id,
    contextId: row.context_id,
    accessScopeId: row.scope,
    agentId: row.agent_id,
    createdBy: row.created_by,
    state: row.state,
    reason: row.reason,
    revision: row.revision,
    queueOrder: row.queue_order,
    instruction: row.instruction,
    executionLimitSeconds: row.execution_limit_seconds,
    inputWaitSeconds: row.input_wait_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function execution(row: Record<string, unknown>) {
  return {
    executionId: row.execution_id,
    taskId: row.task_id,
    generation: row.generation,
    daemonEpoch: row.daemon_epoch,
    launchProfileId: row.launch_profile_id,
    workspaceId: row.workspace_id,
    state: row.state,
    workspaceClaim: row.claim_status,
    candidateOutcome: null,
    revision: row.revision,
  };
}
function claimAndPrepare(p: Record<string, unknown>) {
  const scope = String(p.accessScopeId);
  const taskId = String(p.taskId);
  const executionId = String(p.executionId);
  const generation = String(p.generation);
  const daemonEpoch = String(p.daemonEpoch);
  const stamp = now();
  try {
    return registryFencedTransaction(p.expectedRegistryRevision, () => {
      const row = db
        .prepare(
          "SELECT t.task_id,t.state,t.agent_id,c.binding_snapshot_id,b.workspace_id,json_extract(b.payload_json,'$.runtimeDriver') AS runtime_driver,json_extract(b.payload_json,'$.runtimeVersion') AS runtime_version FROM tasks t JOIN contexts c ON c.context_id=t.context_id JOIN binding_snapshots b ON b.binding_snapshot_id=c.binding_snapshot_id WHERE t.scope=? AND t.task_id=?",
        )
        .get(scope, taskId) as Record<string, unknown> | undefined;
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
      db.prepare(
        "INSERT INTO executions(execution_id,task_id,binding_snapshot_id,generation,daemon_epoch,launch_profile_id,workspace_id,state,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'prepared',1,?,?)",
      ).run(
        executionId,
        taskId,
        row.binding_snapshot_id,
        generation,
        daemonEpoch,
        `${String(row.runtime_driver)}@${String(row.runtime_version)}`,
        row.workspace_id,
        stamp,
        stamp,
      );
      db.prepare(
        "INSERT INTO workspace_claims(workspace_id,execution_id,status,created_at,updated_at) VALUES(?,?,'held',?,?)",
      ).run(row.workspace_id, executionId, stamp, stamp);
      db.prepare(
        "UPDATE tasks SET state='paused',reason='execution_prepared',revision=revision+1,updated_at=? WHERE task_id=?",
      ).run(stamp, taskId);
      return execution(
        db
          .prepare(
            "SELECT e.*,w.status AS claim_status FROM executions e JOIN workspace_claims w ON w.execution_id=e.execution_id WHERE e.execution_id=?",
          )
          .get(executionId) as Record<string, unknown>,
      );
    });
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
function recoverExecutions(): void {
  const stamp = now();
  db.transaction(() => {
    const active = db.prepare("SELECT execution_id FROM executions").all() as {
      execution_id: string;
    }[];
    if (active.length === 0) return;
    db.prepare(
      "UPDATE executions SET state='recovering',revision=revision+1,updated_at=? WHERE state='prepared'",
    ).run(stamp);
    db.prepare(
      "UPDATE workspace_claims SET status='quarantined',updated_at=? WHERE execution_id IN (SELECT execution_id FROM executions WHERE state='recovering')",
    ).run(stamp);
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
      "UPDATE workspace_claims SET status='quarantined',updated_at=? WHERE execution_id=?",
    ).run(stamp, row.execution_id);
    return execution(
      db
        .prepare(
          "SELECT e.*,w.status AS claim_status FROM executions e JOIN workspace_claims w ON w.execution_id=e.execution_id WHERE e.execution_id=?",
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
function receipt(
  scope: string,
  operationId: string,
  operationType: string,
  targetId: string | null,
  fingerprint: string,
) {
  const existing = db
    .prepare(
      "SELECT * FROM operation_receipts WHERE scope=? AND operation_id=?",
    )
    .get(scope, operationId) as Record<string, unknown> | undefined;
  if (!existing) return undefined;
  const result: unknown = JSON.parse(String(existing.result_json));
  const existingTaskId =
    isRecord(result) && typeof result.taskId === "string"
      ? result.taskId
      : undefined;
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
  return result;
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
            "SELECT COALESCE(MAX(cursor), 0) AS cursor FROM task_events WHERE scope=?",
          )
          .get(scope) as { cursor: number }
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
function registryFencedTransaction<T>(
  expectedRevision: unknown,
  operation: () => T,
): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    requireRegistryRevision(expectedRevision);
    const result = operation();
    if (Atomics.load(testCommitBarrier, 0) === 1) {
      Atomics.store(testCommitBarrier, 1, 1);
      Atomics.notify(testCommitBarrier, 1);
      Atomics.wait(testCommitBarrier, 0, 1);
    }
    acquireRegistryCommitFence();
    try {
      requireRegistryRevision(expectedRevision);
      db.exec("COMMIT");
    } finally {
      releaseRegistryCommitFence();
    }
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
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
  try {
    return registryFencedTransaction(p.expectedRegistryRevision, () => {
      const old = receipt(scope, operationId, "submit", null, fingerprint);
      if (old) return { task: old, replayed: true };
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
      const local = capacityValue(workspaceCapacityKey(workspaceId));
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
                "SELECT COALESCE(MAX(queue_order),0) AS q FROM tasks WHERE scope=?",
              )
              .get(scope) as { q: number }
          ).q,
        ) + 1;
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
      db.prepare(
        "INSERT INTO tasks(task_id,context_id,scope,agent_id,created_by,state,revision,queue_order,instruction,execution_limit_seconds,input_wait_seconds,created_at,updated_at) VALUES(?,?,?,?,?,'queued',1,?,?,?,?,?,?)",
      ).run(
        taskId,
        contextId,
        scope,
        agentId,
        principalId,
        queueOrder,
        instruction,
        p.executionLimitSeconds ?? null,
        p.inputWaitSeconds ?? null,
        stamp,
        stamp,
      );
      db.prepare(
        "INSERT INTO task_reservations(task_id,control_receipts,control_events,control_bytes) VALUES(?,?,?,?)",
      ).run(
        taskId,
        options.controlReceiptReserve ?? 1,
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
      changeCapacity(workspaceCapacityKey(workspaceId), 1);
      changeCapacity("reserved_control_bytes", taskControlReserveBytes);
      requirePhysicalHeadroom(physicalAdmissionBytes);
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
function cancel(p: Record<string, unknown>) {
  const scope = String(p.accessScopeId);
  const operationId = String(p.operationId);
  const fingerprint = String(p.fingerprint);
  const taskId = String(p.taskId);
  const principalId = String(p.principalId);
  checkpointWal();
  try {
    return registryFencedTransaction(p.expectedRegistryRevision, () => {
      const old = receipt(scope, operationId, "cancel", taskId, fingerprint);
      if (old) return { task: old, replayed: true };
      const row = db
        .prepare(
          "SELECT t.*,b.workspace_id FROM tasks t JOIN contexts c ON c.context_id=t.context_id JOIN binding_snapshots b ON b.binding_snapshot_id=c.binding_snapshot_id WHERE t.scope=? AND t.task_id=?",
        )
        .get(scope, taskId) as Record<string, unknown> | undefined;
      if (!row || !allowed(row.agent_id, p.allowedAgentIds))
        throwFailure("not_found", "task was not found");
      const execution = db
        .prepare("SELECT 1 AS present FROM executions WHERE task_id=?")
        .get(taskId);
      if (execution !== undefined) {
        throwFailure(
          "operation_conflict",
          "task has a retained Execution claim",
          taskId,
        );
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
    } else if (message.command === "lookupReceipt")
      result = receipt(
        scope,
        String(p.operationId),
        String(p.operationType),
        typeof p.targetId === "string" ? p.targetId : null,
        String(p.fingerprint),
      );
    else if (message.command === "submit") result = submit(p);
    else if (message.command === "cancel") result = cancel(p);
    else if (message.command === "claimAndPrepare") result = claimAndPrepare(p);
    else if (message.command === "recoverExecutions") {
      recoverExecutions();
      result = undefined;
    } else if (message.command === "quarantineExecution") {
      result = quarantineExecution(p);
    } else if (message.command === "getExecution") {
      const agentIds = authorizedAgentIds(p.allowedAgentIds);
      const row = db
        .prepare(
          `SELECT e.*,w.status AS claim_status FROM executions e JOIN tasks t ON t.task_id=e.task_id LEFT JOIN workspace_claims w ON w.execution_id=e.execution_id WHERE t.scope=? AND e.task_id=? AND t.agent_id IN (${agentIds.map(() => "?").join(",")})`,
        )
        .get(scope, String(p.taskId), ...agentIds) as
        Record<string, unknown> | undefined;
      result = row === undefined ? undefined : execution(row);
    } else if (message.command === "get") {
      const r = db
        .prepare("SELECT * FROM tasks WHERE scope=? AND task_id=?")
        .get(scope, String(p.taskId)) as Record<string, unknown> | undefined;
      result =
        r && allowed(r.agent_id, p.allowedAgentIds) ? task(r) : undefined;
    } else if (message.command === "list") {
      const agentIds = authorizedAgentIds(p.allowedAgentIds);
      const filters = [
        "scope=?",
        `agent_id IN (${agentIds.map(() => "?").join(",")})`,
        "queue_order>?",
      ];
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
        filters.push("state=?");
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
      result = { tasks, lastQueueOrder: tasks.at(-1)?.queueOrder };
    } else if (message.command === "events") {
      const agentIds = authorizedAgentIds(p.allowedAgentIds);
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
      result = { events, lastCursor: events.at(-1)?.cursor };
    } else if (message.command === "probe") {
      if (p.probe === "failNextCommit") failNextCommit = true;
      else if (p.probe === "failNextAuditGap") failNextAuditGap = true;
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
      else if (p.probe === "applyExecutionControlRollback") {
        db.exec(executionControlRollbackMigration);
        result = undefined;
      } else if (p.probe === "inspectSchemaVersions") {
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
            code: "storage_capacity" as const,
            message: "physical storage capacity is exhausted",
          }
        : {
            code: "storage_unavailable" as const,
            message: "storage operation failed",
          });
    parentPort?.postMessage({ requestId: message.requestId, failure });
  }
});
