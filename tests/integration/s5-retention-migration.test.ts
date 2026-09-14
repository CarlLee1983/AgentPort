import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { DurableAdmissionStoreError } from "../../src/storage/sqlite-durable-admission-store.js";
import {
  executionControlMigration,
  initialMigration,
  s3aPredispatchMigration,
  s3bDispatchMigration,
  s3bTerminalMigration,
  s4ContextQueueMigration,
  s4ContextResumeMigration,
  s4ProtectedSessionTokensMigration,
  s4QuestionAccountingMigration,
  s4QuestionNativeRelationMigration,
  s4QuestionsMigration,
  s4WorkspaceQueueMigration,
} from "../../src/storage/migration.js";
import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";

const stamp = "2026-09-14T00:00:00.000Z";
const storeOptions = {
  physicalAdmissionBytes: 1_048_576,
  physicalControlReserveBytes: 262_144,
  queueGlobal: 1,
  retentionSweepIntervalMs: 86_400_000,
  taskControlReserveBytes: 131_072,
};

async function seedV12Database(): Promise<{
  databasePath: string;
  directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "agentport-s5-v12-"));
  const databasePath = join(directory, "agentport.sqlite");
  const database = new Database(databasePath);
  try {
    database.pragma("foreign_keys = ON");
    for (const [version, migration] of [
      [1, initialMigration],
      [2, executionControlMigration],
      [3, s3aPredispatchMigration],
      [4, s3bDispatchMigration],
      [5, s3bTerminalMigration],
      [6, s4ContextQueueMigration],
      [7, s4QuestionsMigration],
      [8, s4ProtectedSessionTokensMigration],
      [9, s4QuestionNativeRelationMigration],
      [10, s4ContextResumeMigration],
      [11, s4QuestionAccountingMigration],
      [12, s4WorkspaceQueueMigration],
    ] as const) {
      database.exec(migration);
      database
        .prepare(
          "INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)",
        )
        .run(version, stamp);
    }

    for (const suffix of ["live", "recovering"]) {
      database
        .prepare(
          "INSERT INTO binding_snapshots(binding_snapshot_id,scope,agent_id,workspace_id,payload_json,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          `binding-${suffix}`,
          "scope-a",
          "agent-a",
          `workspace-${suffix}`,
          "{}",
          stamp,
        );
      database
        .prepare(
          "INSERT INTO contexts(context_id,scope,agent_id,binding_snapshot_id,revision,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          `context-${suffix}`,
          "scope-a",
          "agent-a",
          `binding-${suffix}`,
          1,
          stamp,
        );
    }

    database
      .prepare(
        "INSERT INTO tasks(task_id,context_id,scope,agent_id,created_by,state,revision,queue_order,instruction,created_at,updated_at,lifecycle_state) VALUES(?,?,?,?,?,'paused',1,?,?,?,?,'completed')",
      )
      .run(
        "task-live",
        "context-live",
        "scope-a",
        "agent-a",
        "principal-a",
        1,
        "in-period instruction",
        stamp,
        stamp,
      );
    database
      .prepare(
        "INSERT INTO tasks(task_id,context_id,scope,agent_id,created_by,state,revision,queue_order,instruction,created_at,updated_at,lifecycle_state,input_state) VALUES(?,?,?,?,?,'paused',1,?,?,?,?,'recovering','awaiting_input')",
      )
      .run(
        "task-recovering",
        "context-recovering",
        "scope-a",
        "agent-a",
        "principal-a",
        2,
        "protected recovery instruction",
        stamp,
        stamp,
      );
    for (const taskId of ["task-live", "task-recovering"]) {
      database
        .prepare(
          "INSERT INTO task_reservations(task_id,control_receipts,control_events,control_bytes) VALUES(?,?,?,?)",
        )
        .run(taskId, 1, 1, 131_072);
    }

    database
      .prepare(
        "INSERT INTO executions(execution_id,task_id,binding_snapshot_id,generation,daemon_epoch,launch_profile_id,workspace_id,state,revision,created_at,updated_at,lifecycle_state) VALUES(?,?,?,?,?,?,?,'prepared',1,?,?, 'stopping')",
      )
      .run(
        "execution-live",
        "task-live",
        "binding-live",
        "generation-live",
        "epoch-live",
        "profile-live",
        "workspace-live",
        stamp,
        stamp,
      );
    database
      .prepare(
        "INSERT INTO executions(execution_id,task_id,binding_snapshot_id,generation,daemon_epoch,launch_profile_id,workspace_id,state,revision,created_at,updated_at,lifecycle_state) VALUES(?,?,?,?,?,?,?,'recovering',1,?,?, 'recovering')",
      )
      .run(
        "execution-recovering",
        "task-recovering",
        "binding-recovering",
        "generation-recovering",
        "epoch-recovering",
        "profile-recovering",
        "workspace-recovering",
        stamp,
        stamp,
      );
    database
      .prepare(
        "INSERT INTO workspace_claims(workspace_id,execution_id,status,created_at,updated_at) VALUES(?,?,?,?,?)",
      )
      .run(
        "workspace-recovering",
        "execution-recovering",
        "quarantined",
        stamp,
        stamp,
      );
    database
      .prepare(
        "INSERT INTO execution_workspace_claims(execution_id,workspace_id,status,claimed_at,updated_at,released_at) VALUES(?,?,?,?,?,?)",
      )
      .run("execution-live", "workspace-live", "released", stamp, stamp, stamp);
    database
      .prepare(
        "INSERT INTO execution_workspace_claims(execution_id,workspace_id,status,claimed_at,updated_at) VALUES(?,?,?,?,?)",
      )
      .run(
        "execution-recovering",
        "workspace-recovering",
        "quarantined",
        stamp,
        stamp,
      );
    database
      .prepare(
        "INSERT INTO execution_terminals(execution_id,generation,daemon_epoch,launch_profile_id,workspace_identity,platform,execution_unit_id,generation_sealed_at,unit_empty_observed_at,terminal_state,result_json,final_ordinal,committed_at) VALUES(?,?,?,?,?,?,?,?,?,'completed',?,?,?)",
      )
      .run(
        "execution-live",
        "generation-live",
        "epoch-live",
        "profile-live",
        "workspace-live",
        "linux-cgroup-v2",
        "unit-live",
        stamp,
        stamp,
        '{"summary":"in-period result"}',
        1,
        stamp,
      );
    database
      .prepare(
        "INSERT INTO execution_recovery_stop_confirmations(execution_id,generation,daemon_epoch,launch_profile_id,workspace_identity,execution_unit_id,generation_sealed_at,unit_empty_observed_at,confirmed_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "execution-recovering",
        "generation-recovering",
        "epoch-recovering",
        "profile-recovering",
        "workspace-recovering",
        "unit-recovering",
        stamp,
        stamp,
        stamp,
      );
    database
      .prepare(
        "INSERT INTO questions(question_id,task_id,execution_id,generation,daemon_epoch,launch_profile_id,workspace_identity,schema_json,state,delivery_state,answer_fingerprint,answer_json,accepted_actor_principal_id,accepted_at,expires_at,created_at,native_tool_use_id,native_request_id,closed_at,closure_reason) VALUES(?,?,?,?,?,?,?,?, 'closed','pending',?,?,?,?,?,?,?,?,?,'terminal')",
      )
      .run(
        "question-recovering",
        "task-recovering",
        "execution-recovering",
        "generation-recovering",
        "epoch-recovering",
        "profile-recovering",
        "workspace-recovering",
        "[]",
        "answer-fingerprint",
        "{}",
        "principal-a",
        stamp,
        "2026-10-14T00:00:00.000Z",
        stamp,
        "tool-recovering",
        "request-recovering",
        stamp,
      );
    database
      .prepare(
        "INSERT INTO operation_receipts(scope,operation_id,operation_type,target_id,fingerprint,actor_principal_id,result_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        "scope-a",
        "live-submit",
        "submit",
        "task-live",
        "live-fingerprint",
        "principal-a",
        '{"taskId":"task-live","summary":"receipt sentinel"}',
        stamp,
      );
    for (const [cursor, taskId] of [
      [1, "task-live"],
      [2, "task-recovering"],
    ] as const) {
      database
        .prepare(
          "INSERT INTO task_events(scope,cursor,task_id,task_sequence,revision,event_type,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run("scope-a", cursor, taskId, 1, 1, "fixture", "{}", stamp);
    }
    database
      .prepare(
        "INSERT INTO task_workspace_queue(admission_sequence,task_id,workspace_id) VALUES(?,?,?)",
      )
      .run(1, "task-live", "workspace-live");
    database
      .prepare(
        "INSERT INTO task_workspace_queue(admission_sequence,task_id,workspace_id) VALUES(?,?,?)",
      )
      .run(2, "task-recovering", "workspace-recovering");
  } finally {
    database.close();
  }
  return { databasePath, directory };
}

function snapshotV12Rows(databasePath: string) {
  const database = new Database(databasePath, { fileMustExist: true });
  try {
    return {
      contexts: database
        .prepare("SELECT * FROM contexts ORDER BY context_id")
        .all(),
      events: database
        .prepare("SELECT * FROM task_events ORDER BY cursor")
        .all(),
      executionClaims: database
        .prepare(
          "SELECT * FROM execution_workspace_claims ORDER BY execution_id",
        )
        .all(),
      questions: database
        .prepare("SELECT * FROM questions ORDER BY question_id")
        .all(),
      recovery: database
        .prepare(
          "SELECT * FROM execution_recovery_stop_confirmations ORDER BY execution_id",
        )
        .all(),
      receipts: database
        .prepare(
          "SELECT scope,operation_id,operation_type,target_id,fingerprint,actor_principal_id,result_json,created_at FROM operation_receipts ORDER BY operation_id",
        )
        .all(),
      tasks: database.prepare("SELECT * FROM tasks ORDER BY task_id").all(),
      workspaceClaims: database
        .prepare("SELECT * FROM workspace_claims ORDER BY workspace_id")
        .all(),
    };
  } finally {
    database.close();
  }
}

describe("S5 retention migration", () => {
  it("enforces current Agent authorization for v12 recovery-only receipts", async () => {
    const seeded = await seedV12Database();
    let store: SqliteDurableAdmissionStore | undefined;
    try {
      store = await SqliteDurableAdmissionStore.open({
        ...storeOptions,
        databasePath: seeded.databasePath,
        recoveryOnly: true,
      });

      await expect(
        store.lookupReceipt({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-other"],
          expectedAgentId: "agent-other",
          operationId: "live-submit",
          operationType: "submit",
          targetId: "task-live",
          fingerprint: "live-fingerprint",
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DurableAdmissionStoreError &&
          error.code === "not_found",
      );
      await expect(
        store.lookupReceipt({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          expectedAgentId: "agent-a",
          operationId: "live-submit",
          operationType: "submit",
          targetId: "task-live",
          fingerprint: "live-fingerprint",
        }),
      ).resolves.toMatchObject({
        taskId: "task-live",
        summary: "receipt sentinel",
      });
    } finally {
      await store?.close();
      await rm(seeded.directory, { force: true, recursive: true });
    }
  });

  it("upgrades v12 additively without cleaning or mutating retained and protected rows", async () => {
    const seeded = await seedV12Database();
    let store: SqliteDurableAdmissionStore | undefined;
    try {
      const before = snapshotV12Rows(seeded.databasePath);
      store = await SqliteDurableAdmissionStore.open({
        ...storeOptions,
        databasePath: seeded.databasePath,
      });
      await expect(store.probe("inspectSchemaVersions")).resolves.toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
      ]);
      await store.close();
      store = undefined;

      expect(snapshotV12Rows(seeded.databasePath)).toEqual(before);
      const inspected = new Database(seeded.databasePath, {
        fileMustExist: true,
      });
      try {
        expect(
          inspected
            .prepare(
              "SELECT retained_task_id,expired_at FROM operation_receipts WHERE operation_id='live-submit'",
            )
            .get(),
        ).toEqual({ retained_task_id: "task-live", expired_at: null });
        expect(
          inspected
            .prepare("SELECT COUNT(*) AS count FROM task_expiry_markers")
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        inspected.close();
      }
    } finally {
      await store?.close();
      await rm(seeded.directory, { force: true, recursive: true });
    }
  });

  it("preserves v13 expiry markers and expired receipt semantics across restart", async () => {
    const seeded = await seedV12Database();
    let store: SqliteDurableAdmissionStore | undefined;
    try {
      store = await SqliteDurableAdmissionStore.open({
        ...storeOptions,
        databasePath: seeded.databasePath,
      });
      await expect(
        store.expireRetainedData({ asOf: "2026-10-15T00:00:00.000Z" }),
      ).resolves.toMatchObject({ tasksExpired: 1, receiptsTombstoned: 1 });
      await store.close();
      store = await SqliteDurableAdmissionStore.open({
        ...storeOptions,
        databasePath: seeded.databasePath,
      });

      await expect(
        store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: "task-live",
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DurableAdmissionStoreError &&
          error.code === "result_expired",
      );
      await expect(
        store.lookupReceipt({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          expectedAgentId: "agent-a",
          operationId: "live-submit",
          operationType: "submit",
          targetId: "task-live",
          fingerprint: "live-fingerprint",
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DurableAdmissionStoreError &&
          error.code === "result_expired",
      );
      await expect(
        store.expireRetainedData({ asOf: "2026-10-16T00:00:00.000Z" }),
      ).resolves.toMatchObject({ tasksExpired: 0, receiptsTombstoned: 0 });
    } finally {
      await store?.close();
      await rm(seeded.directory, { force: true, recursive: true });
    }
  });

  it("fails closed for a v13 database carrying an unknown newer schema version", async () => {
    const seeded = await seedV12Database();
    let store: SqliteDurableAdmissionStore | undefined;
    try {
      store = await SqliteDurableAdmissionStore.open({
        ...storeOptions,
        databasePath: seeded.databasePath,
      });
      await store.probe("setFutureSchemaVersion");
      await store.close();
      store = undefined;

      await expect(
        SqliteDurableAdmissionStore.open({
          ...storeOptions,
          databasePath: seeded.databasePath,
        }),
      ).rejects.toThrow();
    } finally {
      await store?.close();
      await rm(seeded.directory, { force: true, recursive: true });
    }
  });
});
