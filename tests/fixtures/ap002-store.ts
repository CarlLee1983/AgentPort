import {
  closeSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

const AP002_REQUIRED_TABLES = [
  "binding_snapshots",
  "capacity_metadata",
  "contexts",
  "operation_receipts",
  "product_audit_records",
  "product_audit_state",
  "schema_migrations",
  "store_metadata",
  "task_events",
  "task_reservations",
  "tasks",
] as const;

interface ReopenRequest {
  databasePath: string;
  taskId: string;
}

interface ReopenSnapshot {
  schemaVersions: number[];
  task: { instruction: string } | undefined;
  retainedExecutionClaim:
    { taskId: string; status: "held" | "quarantined" } | undefined;
}

/**
 * Replays the accepted AP-002 store's schema, lock, and control-reserve startup
 * boundary without adding an old-schema mode to the production AP-003 store.
 */
export function reopenWithAp002Store({
  databasePath,
  taskId,
}: ReopenRequest): ReopenSnapshot {
  const taskControlReserveBytes = 128 * 1024;
  const physicalCapacityBytes = 2.25 * 1024 * 1024 * 1024;
  const controlReservePath = `${databasePath}.control-reserve`;
  const database = new Database(databasePath, { fileMustExist: true });
  let controlReserveFile: number | undefined;

  try {
    database.pragma("busy_timeout = 500");
    database.pragma("locking_mode = EXCLUSIVE");
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma("synchronous = FULL");
    const pageSize = Number(database.pragma("page_size", { simple: true }));
    if (taskControlReserveBytes < 32 * pageSize) {
      throw new Error("AP-002 Task control reserve is too small");
    }
    database.pragma(
      `max_page_count = ${String(Math.floor(physicalCapacityBytes / pageSize))}`,
    );

    const schemaVersions = (
      database
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as { version: number }[]
    ).map(({ version }) => version);
    if (schemaVersions.length !== 1 || schemaVersions[0] !== 1) {
      throw new Error("unsupported AP-002 durable admission schema version");
    }

    const actualTables = new Set(
      (
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map(({ name }) => name),
    );
    if (AP002_REQUIRED_TABLES.some((name) => !actualTables.has(name))) {
      throw new Error("AP-002 durable admission schema is incomplete");
    }
    const receiptColumns = new Set(
      (
        database.pragma("table_info(operation_receipts)") as { name: string }[]
      ).map(({ name }) => name),
    );
    const auditStateColumns = new Set(
      (
        database.pragma("table_info(product_audit_state)") as { name: string }[]
      ).map(({ name }) => name),
    );
    if (!receiptColumns.has("actor_principal_id")) {
      throw new Error(
        "AP-002 durable admission receipt schema is incompatible",
      );
    }
    if (!auditStateColumns.has("last_gap_operation_id")) {
      throw new Error("AP-002 durable admission audit schema is incompatible");
    }

    // AP-002 retained this exclusive lock for the lifetime of its worker.
    database.exec("BEGIN IMMEDIATE; COMMIT;");
    const pausedControlReserveBytes =
      taskControlReserveBytes - Math.floor(taskControlReserveBytes / 2);
    const invalidReservation = database
      .prepare(
        "SELECT t.task_id FROM tasks t LEFT JOIN task_reservations r ON r.task_id=t.task_id WHERE t.state IN ('queued','paused') AND (r.task_id IS NULL OR r.control_receipts<1 OR r.control_bytes < CASE t.state WHEN 'queued' THEN ? ELSE ? END OR r.control_events < CASE t.state WHEN 'queued' THEN 2 ELSE 1 END) LIMIT 1",
      )
      .get(taskControlReserveBytes, pausedControlReserveBytes);
    if (invalidReservation !== undefined) {
      throw new Error("AP-002 active Task reservation ledger is inconsistent");
    }

    const reservedControlBytes = (
      database
        .prepare(
          "SELECT COALESCE(SUM(control_bytes), 0) AS value FROM task_reservations",
        )
        .get() as { value: number }
    ).value;
    controlReserveFile = openSync(controlReservePath, "a+");
    const currentBytes = statSync(controlReservePath).size;
    if (currentBytes > reservedControlBytes) {
      ftruncateSync(controlReserveFile, reservedControlBytes);
    } else if (currentBytes < reservedControlBytes) {
      const chunk = Buffer.alloc(64 * 1024, 0xa5);
      let offset = currentBytes;
      while (offset < reservedControlBytes) {
        const length = Math.min(
          chunk.byteLength,
          reservedControlBytes - offset,
        );
        const written = writeSync(controlReserveFile, chunk, 0, length, offset);
        if (written !== length) {
          throw new Error("AP-002 control reserve write was incomplete");
        }
        offset += written;
      }
    }
    fsyncSync(controlReserveFile);
    const reserveStat = statSync(controlReservePath);
    if (
      reserveStat.size !== reservedControlBytes ||
      reserveStat.blocks * 512 < reservedControlBytes
    ) {
      throw new Error(
        "AP-002 physical control reserve is sparse or incomplete",
      );
    }
    if (statSync(databasePath).dev !== reserveStat.dev) {
      throw new Error(
        `AP-002 database and control reserve must share ${dirname(databasePath)}`,
      );
    }

    return {
      schemaVersions,
      task: database
        .prepare("SELECT instruction FROM tasks WHERE task_id = ?")
        .get(taskId) as { instruction: string } | undefined,
      retainedExecutionClaim: database
        .prepare(
          "SELECT e.task_id AS taskId, w.status FROM executions e JOIN workspace_claims w ON w.execution_id = e.execution_id WHERE e.task_id = ?",
        )
        .get(taskId) as ReopenSnapshot["retainedExecutionClaim"],
    };
  } finally {
    if (controlReserveFile !== undefined) closeSync(controlReserveFile);
    database.close();
  }
}
