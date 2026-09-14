import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { AgentRegistry } from "../../src/bootstrap/registry.js";
import { DurableAgentExecutionService } from "../../src/core/agent-execution-service.js";
import {
  executionControlMigration,
  initialMigration,
  s3aPredispatchMigration,
  s3bDispatchMigration,
  s3bTerminalMigration,
} from "../../src/storage/migration.js";
import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";
import {
  createDurableAdmissionFixture,
  type DurableAdmissionFixture,
} from "../fixtures/durable-admission.js";
import { submit } from "../fixtures/durable-store.js";

const questionSchema = [
  {
    question: "Which color should be used?",
    header: "Color",
    options: [
      { label: "Blue", description: "Use blue" },
      { label: "Red", description: "Use red" },
    ],
    multiSelect: false,
  },
] as const;

async function seedPreS4Database(): Promise<{
  directory: string;
  databasePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "agentport-s4-upgrade-"));
  const databasePath = join(directory, "agentport.sqlite");
  const database = new Database(databasePath);
  const stamp = "2026-09-14T00:00:00.000Z";
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    for (const [version, migration] of [
      [1, initialMigration],
      [2, executionControlMigration],
      [3, s3aPredispatchMigration],
      [4, s3bDispatchMigration],
      [5, s3bTerminalMigration],
    ] as const) {
      database.exec(migration);
      database
        .prepare(
          "INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)",
        )
        .run(version, stamp);
    }
    database
      .prepare(
        "INSERT INTO binding_snapshots(binding_snapshot_id,scope,agent_id,workspace_id,payload_json,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run("binding-s3", "scope-a", "agent-a", "workspace-s3", "{}", stamp);
    database
      .prepare(
        "INSERT INTO contexts(context_id,scope,agent_id,binding_snapshot_id,revision,session_reference,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        "context-s3",
        "scope-a",
        "agent-a",
        "binding-s3",
        2,
        "session-s3",
        stamp,
      );
    database
      .prepare(
        "INSERT INTO tasks(task_id,context_id,scope,agent_id,created_by,state,revision,queue_order,instruction,created_at,updated_at,lifecycle_state) VALUES(?,?,?,?,?,'paused',2,?,?,?,?,'completed')",
      )
      .run(
        "task-s3",
        "context-s3",
        "scope-a",
        "agent-a",
        "principal-a",
        1,
        "retain S3 task",
        stamp,
        stamp,
      );
    database
      .prepare(
        "INSERT INTO task_reservations(task_id,control_receipts,control_events,control_bytes) VALUES(?,1,1,65536)",
      )
      .run("task-s3");
    database
      .prepare(
        "INSERT INTO executions(execution_id,task_id,binding_snapshot_id,generation,daemon_epoch,launch_profile_id,workspace_id,state,revision,created_at,updated_at,lifecycle_state,last_observation_ordinal,observation_bytes,candidate_ordinal) VALUES(?,?,?,?,?,?,?,'prepared',1,?,?, 'running',1,24,1)",
      )
      .run(
        "execution-s3",
        "task-s3",
        "binding-s3",
        "generation-s3",
        "epoch-s3",
        "profile-s3",
        "workspace-s3",
        stamp,
        stamp,
      );
    database
      .prepare(
        "INSERT INTO workspace_claims(workspace_id,execution_id,status,created_at,updated_at) VALUES(?,?,?,?,?)",
      )
      .run("workspace-s3", "execution-s3", "held", stamp, stamp);
    database
      .prepare(
        "INSERT INTO execution_workspace_claims(execution_id,workspace_id,status,claimed_at,updated_at,released_at) VALUES(?,?,?,?,?,?)",
      )
      .run("execution-s3", "workspace-s3", "released", stamp, stamp, stamp);
    database
      .prepare(
        "INSERT INTO operation_receipts(scope,operation_id,operation_type,target_id,fingerprint,actor_principal_id,result_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        "scope-a",
        "receipt-s3",
        "submit",
        "task-s3",
        "fingerprint-s3",
        "principal-a",
        "{}",
        stamp,
      );
    database
      .prepare(
        "INSERT INTO task_events(scope,cursor,task_id,task_sequence,revision,event_type,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run("scope-a", 1, "task-s3", 1, 2, "completed", "{}", stamp);
    database
      .prepare(
        "INSERT INTO execution_observations(execution_id,generation,daemon_epoch,launch_profile_id,workspace_identity,ordinal,kind,payload_json,payload_fingerprint,payload_bytes,final_ordinal,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "execution-s3",
        "generation-s3",
        "epoch-s3",
        "profile-s3",
        "workspace-s3",
        1,
        "candidate",
        "{}",
        "observation-s3",
        24,
        1,
        stamp,
      );
  } finally {
    database.close();
  }
  return { directory, databasePath };
}

async function restartFixture(fixture: DurableAdmissionFixture) {
  await fixture.store.close();
  const store = await SqliteDurableAdmissionStore.open({
    databasePath: fixture.databasePath,
  });
  const registry = await AgentRegistry.create(
    fixture.registryConfiguration,
    store,
  );
  const { service } =
    DurableAgentExecutionService.createPlatformNeutralPreparationFixture(
      registry,
      store,
      {
        cursorSecret: "s4-restart-cursor-secret",
        newId: () => "restart-id",
        now: () => new Date("2026-09-12T08:00:00.000Z"),
      },
    );
  await service.initializeAfterRestart();
  return { service, store };
}

async function startQuestion(fixture: DurableAdmissionFixture, suffix: string) {
  const submitted = await fixture.service.submitTask(
    { principalId: "principal-a" },
    { operationId: `${suffix}-submit`, agentId: "agent-a", instruction: "Ask" },
  );
  const { reference } = await fixture.service.prepareForDispatch(
    submitted.task.taskId,
    `${suffix}-epoch`,
  );
  await fixture.service.markExecutionRunning(reference);
  const identity = {
    questionId: `${suffix}-question`,
    toolUseId: `${suffix}-tool`,
    requestId: `${suffix}-request`,
  };
  await fixture.service.persistRuntimeQuestion(submitted.task.taskId, {
    reference,
    ...identity,
    ordinal: 1,
    toolActivity: "none",
    questions: questionSchema,
  });
  return { taskId: submitted.task.taskId, reference, identity };
}

async function completeTask(fixture: DurableAdmissionFixture, suffix: string) {
  const submitted = await fixture.service.submitTask(
    { principalId: "principal-a" },
    {
      operationId: `${suffix}-submit`,
      agentId: "agent-a",
      instruction: "Finish",
    },
  );
  const { reference } = await fixture.service.prepareForDispatch(
    submitted.task.taskId,
    `${suffix}-epoch`,
  );
  await fixture.service.markExecutionRunning(reference);
  await fixture.recordObservation(
    { principalId: "principal-a" },
    {
      taskId: submitted.task.taskId,
      observation: {
        kind: "candidate",
        reference,
        ordinal: 1,
        finalOrdinal: 1,
        outcome: { kind: "completed", summary: "finished" },
        sessionReference: null,
      },
    },
  );
  await fixture.store.commitTerminal({
    evidence: {
      platform: "linux-cgroup-v2",
      reference,
      executionUnitId: `${suffix}-unit`,
      generationSealedAt: "2026-09-12T07:00:01.000Z",
      unitEmptyObservedAt: "2026-09-12T07:00:02.000Z",
    },
  });
  return submitted.task;
}

describe("S4 migration and restart recovery", () => {
  it("backfills v11 Tasks into one cross-scope Workspace admission order", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "agentport-s4-v12-upgrade-"),
    );
    const databasePath = join(directory, "agentport.sqlite");
    let store: SqliteDurableAdmissionStore | undefined;
    try {
      store = await SqliteDurableAdmissionStore.open({ databasePath });
      await store.submit(
        submit({
          operationId: "v12-scope-a",
          fingerprint: "v12-scope-a",
          taskId: "v12-scope-a-task",
          contextId: "v12-scope-a-context",
        }),
      );
      await store.submit(
        submit({
          accessScopeId: "scope-b",
          principalId: "principal-b",
          operationId: "v12-scope-b",
          fingerprint: "v12-scope-b",
          taskId: "v12-scope-b-task",
          contextId: "v12-scope-b-context",
          binding: {
            ...submit().binding,
            bindingSnapshotId: "v12-scope-b-binding",
          },
        }),
      );
      await store.close();
      store = undefined;

      const legacy = new Database(databasePath);
      try {
        legacy.exec(
          `DROP TRIGGER operation_receipts_capture_task_id;
           DROP INDEX operation_receipts_retained_task;
           DROP TABLE task_expiry_markers;
           ALTER TABLE operation_receipts DROP COLUMN expired_at;
           ALTER TABLE operation_receipts DROP COLUMN retained_task_id;
           DROP TABLE task_workspace_queue;
           DELETE FROM schema_migrations WHERE version IN (12,13);`,
        );
      } finally {
        legacy.close();
      }

      store = await SqliteDurableAdmissionStore.open({ databasePath });
      await expect(store.probe("inspectSchemaVersions")).resolves.toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
      ]);
      await expect(
        store.getEligibleTasksForDispatch({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          limit: 10,
        }),
      ).resolves.toMatchObject([{ taskId: "v12-scope-a-task" }]);
      await expect(
        store.getEligibleTasksForDispatch({
          accessScopeId: "scope-b",
          allowedAgentIds: ["agent-a"],
          limit: 10,
        }),
      ).resolves.toEqual([]);
    } finally {
      await store?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("upgrades a pre-S4 S3 database additively without losing durable records", async () => {
    const seeded = await seedPreS4Database();
    let store: SqliteDurableAdmissionStore | undefined;
    try {
      store = await SqliteDurableAdmissionStore.open({
        databasePath: seeded.databasePath,
      });
      await expect(store.probe("inspectSchemaVersions")).resolves.toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
      ]);
      await store.close();
      store = undefined;

      const inspected = new Database(seeded.databasePath, {
        fileMustExist: true,
      });
      try {
        for (const [table, count] of [
          ["tasks", 1],
          ["contexts", 1],
          ["executions", 1],
          ["workspace_claims", 1],
          ["execution_workspace_claims", 1],
          ["operation_receipts", 1],
          ["task_events", 1],
          ["execution_observations", 1],
        ] as const) {
          expect(
            inspected.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
          ).toEqual({ count });
        }
        expect(
          inspected
            .prepare(
              "SELECT session_reference FROM contexts WHERE context_id='context-s3'",
            )
            .get(),
        ).toEqual({ session_reference: "session-s3" });
        expect(
          inspected
            .prepare(
              "SELECT instruction,lifecycle_state FROM tasks WHERE task_id='task-s3'",
            )
            .get(),
        ).toEqual({
          instruction: "retain S3 task",
          lifecycle_state: "completed",
        });
      } finally {
        inspected.close();
      }
    } finally {
      await store?.close();
      await rm(seeded.directory, { force: true, recursive: true });
    }
  });

  it("never reopens a pending callback after a daemon crash", async () => {
    const fixture = await createDurableAdmissionFixture();
    let reopened: Awaited<ReturnType<typeof restartFixture>> | undefined;
    try {
      const pending = await startQuestion(fixture, "pending-crash");
      reopened = await restartFixture(fixture);
      await expect(
        reopened.service.getTask(
          { principalId: "principal-a" },
          { taskId: pending.taskId },
        ),
      ).resolves.toMatchObject({
        state: "recovering",
        question: { state: "closed", delivery: "pending" },
      });
      await expect(
        reopened.store.getQuestionForDelivery({
          reference: pending.reference,
          ...pending.identity,
          now: "2026-09-12T08:00:00.000Z",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await reopened?.store.close();
      await rm(fixture.directory, { force: true, recursive: true });
    }
  });

  it("retains a committed answer but marks delivery unknown after worker loss", async () => {
    const fixture = await createDurableAdmissionFixture();
    let reopened: Awaited<ReturnType<typeof restartFixture>> | undefined;
    try {
      const accepted = await startQuestion(fixture, "accepted-crash");
      await fixture.service.reply(
        { principalId: "principal-a" },
        {
          operationId: "accepted-crash-reply",
          taskId: accepted.taskId,
          questionId: accepted.identity.questionId,
          answer: { "Which color should be used?": "Blue" },
        },
      );
      reopened = await restartFixture(fixture);
      await expect(
        reopened.service.getTask(
          { principalId: "principal-a" },
          { taskId: accepted.taskId },
        ),
      ).resolves.toMatchObject({
        state: "recovering",
        question: { state: "accepted", delivery: "unknown" },
      });
      await expect(
        reopened.store.getQuestionForDelivery({
          reference: accepted.reference,
          ...accepted.identity,
          now: "2026-09-12T08:00:00.000Z",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await reopened?.store.close();
      await rm(fixture.directory, { force: true, recursive: true });
    }
  });

  it("leaves a terminal Task terminal when the daemon restarts", async () => {
    const fixture = await createDurableAdmissionFixture();
    let reopened: Awaited<ReturnType<typeof restartFixture>> | undefined;
    try {
      const completed = await completeTask(fixture, "terminal-restart");
      reopened = await restartFixture(fixture);
      await expect(
        reopened.service.getTask(
          { principalId: "principal-a" },
          { taskId: completed.taskId },
        ),
      ).resolves.toMatchObject({ state: "completed" });
      await expect(reopened.store.recoverExecutions()).resolves.toEqual([]);
    } finally {
      await reopened?.store.close();
      await rm(fixture.directory, { force: true, recursive: true });
    }
  });

  it("blocks preexisting and newly admitted followers until recovered work is acknowledged", async () => {
    const fixture = await createDurableAdmissionFixture();
    let reopened: Awaited<ReturnType<typeof restartFixture>> | undefined;
    try {
      const predecessor = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "restart-predecessor",
          agentId: "agent-a",
          instruction: "Work",
        },
      );
      const successor = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "restart-successor",
          agentId: "agent-a",
          contextId: predecessor.task.contextId,
          instruction: "Wait behind recovery",
        },
      );
      const { reference } = await fixture.service.prepareForDispatch(
        predecessor.task.taskId,
        "restart-recovery-epoch",
      );
      await fixture.service.markExecutionRunning(reference);

      reopened = await restartFixture(fixture);
      const late = await reopened.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "restart-late-successor",
          agentId: "agent-a",
          contextId: predecessor.task.contextId,
          instruction: "Remain blocked after restart",
        },
      );
      await expect(
        reopened.service.getTask(
          { principalId: "principal-a" },
          { taskId: successor.task.taskId },
        ),
      ).resolves.toMatchObject({
        state: "paused",
        blocker: {
          predecessorTaskId: predecessor.task.taskId,
          state: "recovering",
        },
      });
      expect(late.task).toMatchObject({
        state: "paused",
        blocker: {
          predecessorTaskId: predecessor.task.taskId,
          state: "recovering",
        },
      });
      await expect(
        reopened.service.prepareForDispatch(
          late.task.taskId,
          "restart-late-epoch",
        ),
      ).rejects.toMatchObject({ code: "invalid_state" });
      await expect(
        reopened.service.resumeContext(
          { principalId: "principal-a" },
          {
            operationId: "restart-early-resume",
            contextId: predecessor.task.contextId,
            expectedRevision: late.task.contextRevision,
            continuationMode: "fresh_session",
            contextSummary: "",
          },
        ),
      ).rejects.toMatchObject({ code: "invalid_state" });

      await reopened.store.confirmRecoveryStopped({
        evidence: {
          platform: "linux-cgroup-v2",
          reference,
          executionUnitId: "restart-recovery-unit",
          generationSealedAt: "2026-09-12T08:00:01.000Z",
          unitEmptyObservedAt: "2026-09-12T08:00:02.000Z",
        },
        now: "2026-09-12T08:00:02.000Z",
      });
      const recovering = await reopened.service.getTask(
        { principalId: "principal-a" },
        { taskId: predecessor.task.taskId },
      );
      await reopened.service.acknowledgeInterruption(
        { principalId: "principal-a" },
        {
          operationId: "restart-acknowledge",
          taskId: predecessor.task.taskId,
          expectedRevision: recovering.revision,
        },
      );
      const blocked = await reopened.service.getTask(
        { principalId: "principal-a" },
        { taskId: successor.task.taskId },
      );
      await expect(
        reopened.service.resumeContext(
          { principalId: "principal-a" },
          {
            operationId: "restart-resume",
            contextId: predecessor.task.contextId,
            expectedRevision: blocked.contextRevision,
            continuationMode: "fresh_session",
            contextSummary: "",
          },
        ),
      ).resolves.toMatchObject({
        task: { taskId: successor.task.taskId, state: "queued" },
      });
    } finally {
      await reopened?.store.close();
      await rm(fixture.directory, { force: true, recursive: true });
    }
  });
});
