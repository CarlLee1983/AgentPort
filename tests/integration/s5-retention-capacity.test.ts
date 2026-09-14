import { stat } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";
import { openStore, submit } from "../fixtures/durable-store.js";

const schema = [
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

function dispatchRequest(taskId: string, suffix: string) {
  return {
    accessScopeId: "scope-a",
    allowedAgentIds: ["agent-a"],
    expectedRegistryRevision: 0,
    executionId: `capacity-execution-${suffix}`,
    taskId,
    generation: `capacity-generation-${suffix}`,
    daemonEpoch: `capacity-epoch-${suffix}`,
    dispatchIntent: true,
    binding: {
      ...submit().binding,
      bindingSnapshotId: `capacity-binding-${suffix}`,
      accessScopeId: "scope-a",
      agentId: "agent-a",
      createdAt: "2026-09-14T00:00:00.000Z",
    },
  };
}

async function prepareRunningTask(
  store: SqliteDurableAdmissionStore,
  taskId: string,
  suffix: string,
) {
  const execution = await store.claimAndPrepare(
    dispatchRequest(taskId, suffix),
  );
  const reference = {
    executionId: execution.executionId,
    generation: execution.generation,
    daemonEpoch: execution.daemonEpoch,
    launchProfileId: execution.launchProfileId,
    workspaceIdentity: execution.workspaceId,
  };
  await store.markExecutionRunning({ reference });
  return reference;
}

async function completeTask(
  store: SqliteDurableAdmissionStore,
  taskId: string,
  suffix: string,
  summary = "in-period-result",
) {
  const reference = await prepareRunningTask(store, taskId, suffix);
  await store.commitRuntimeObservation({
    taskId,
    now: "2026-09-14T00:00:01.000Z",
    observation: {
      kind: "candidate",
      ordinal: 1,
      finalOrdinal: 1,
      reference,
      outcome: { kind: "completed", summary },
      sessionReference: null,
    },
  });
  await store.commitTerminal({
    evidence: {
      platform: "linux-cgroup-v2",
      reference,
      executionUnitId: `capacity-unit-${suffix}`,
      generationSealedAt: "2026-09-14T00:00:02.000Z",
      unitEmptyObservedAt: "2026-09-14T00:00:03.000Z",
    },
  });
}

describe("S5 retention capacity", () => {
  it("enforces the exact default 100,000-receipt and 2 GiB admission boundaries", async () => {
    const fixture = await openStore();
    const databasePath = join(fixture.directory, "store.sqlite");
    let store: SqliteDurableAdmissionStore | undefined = fixture.store;
    try {
      await store.close();
      store = undefined;
      const database = new Database(databasePath);
      try {
        database.exec(`
          WITH digits(value) AS (
            VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
          ), receipt_numbers(value) AS (
            SELECT a.value + 10*b.value + 100*c.value + 1000*d.value + 10000*e.value
            FROM digits a, digits b, digits c, digits d, digits e
          )
          INSERT INTO operation_receipts(
            scope,operation_id,operation_type,target_id,fingerprint,
            actor_principal_id,result_json,created_at
          )
          SELECT
            'scope-a','capacity-' || printf('%05d',value),'edit',NULL,
            'capacity-fingerprint','principal-a','{}','2026-09-14T00:00:00.000Z'
          FROM receipt_numbers;
        `);
      } finally {
        database.close();
      }

      store = await SqliteDurableAdmissionStore.open({ databasePath });
      await expect(
        store.probe("inspectPhysicalCapacity"),
      ).resolves.toMatchObject({
        physicalAdmissionBytes: 2 * 1024 * 1024 * 1024,
      });
      await expect(
        store.submit(
          submit({
            operationId: "capacity-default-rejected-submit",
            taskId: "capacity-default-rejected-task",
            contextId: "capacity-default-rejected-context",
          }),
        ),
      ).rejects.toMatchObject({ code: "tombstone_capacity" });
    } finally {
      await store?.close();
      await fixture.dispose();
    }
  });

  it("rejects general-reserve submit, edit, and resume without changing retained work", async () => {
    const fixture = await openStore({ receiptCapacity: 2 });
    try {
      const predecessor = await fixture.store.submit(submit());
      if (predecessor.replayed) {
        throw new Error("predecessor fixture unexpectedly replayed");
      }
      const successor = await fixture.store.submit(
        submit({
          operationId: "capacity-successor-submit",
          fingerprint: "capacity-successor-submit",
          taskId: "capacity-successor",
          contextId: predecessor.task.contextId,
          existingContextId: predecessor.task.contextId,
          binding: {
            ...submit().binding,
            bindingSnapshotId: "capacity-successor-binding",
          },
        }),
      );
      await fixture.store.cancel({
        accessScopeId: "scope-a",
        principalId: "principal-a",
        operationId: "capacity-cancel-predecessor",
        fingerprint: "capacity-cancel-predecessor",
        taskId: predecessor.task.taskId,
        expectedStates: ["queued", "paused"],
        nextState: "canceled",
        eventType: "canceled",
      });
      const paused = await fixture.store.getTask({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        taskId: successor.task.taskId,
      });
      if (paused === undefined) throw new Error("successor was not retained");

      await expect(
        fixture.store.submit(
          submit({
            operationId: "capacity-rejected-submit",
            taskId: "capacity-rejected-task",
            contextId: "capacity-rejected-context",
            binding: {
              ...submit().binding,
              bindingSnapshotId: "capacity-rejected-binding",
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "tombstone_capacity" });
      await expect(
        fixture.store.edit({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          expectedRegistryRevision: 0,
          principalId: "principal-a",
          operationId: "capacity-rejected-edit",
          fingerprint: "capacity-rejected-edit",
          taskId: successor.task.taskId,
          expectedRevision: paused.revision,
          instruction: "must not replace retained work",
          now: "2026-09-14T00:00:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "tombstone_capacity" });
      await expect(
        fixture.store.resumeContext({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          expectedRegistryRevision: 0,
          principalId: "principal-a",
          operationId: "capacity-rejected-resume",
          fingerprint: "capacity-rejected-resume",
          contextId: predecessor.task.contextId,
          expectedRevision: paused.contextRevision,
          continuationMode: "fresh_session",
          contextSummary: "",
          now: "2026-09-14T00:00:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "tombstone_capacity" });
      await expect(
        fixture.store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: successor.task.taskId,
        }),
      ).resolves.toMatchObject({
        state: "paused",
        instruction: "durable task",
        revision: paused.revision,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("keeps an existing-task reply usable when general receipts are saturated", async () => {
    const fixture = await openStore({ receiptCapacity: 2 });
    let reopened: SqliteDurableAdmissionStore | undefined;
    try {
      const questioned = await fixture.store.submit(submit());
      const reference = await prepareRunningTask(
        fixture.store,
        questioned.task.taskId,
        "reply",
      );
      await fixture.store.persistQuestionObservation({
        reference,
        questionId: "capacity-question",
        toolUseId: "capacity-tool",
        requestId: "capacity-request",
        ordinal: 1,
        toolActivity: "none",
        activeElapsedMs: 0,
        schema,
        expiresAt: "2026-09-15T00:00:00.000Z",
        now: "2026-09-14T00:00:00.000Z",
      });
      await fixture.store.submit(
        submit({
          operationId: "capacity-fill-general",
          fingerprint: "capacity-fill-general",
          taskId: "capacity-cancellable",
          contextId: "capacity-cancellable-context",
          binding: {
            ...submit().binding,
            bindingSnapshotId: "capacity-cancellable-binding",
          },
        }),
      );

      const replyRequest = {
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        expectedRegistryRevision: 0,
        principalId: "principal-a",
        operationId: "capacity-reserved-reply",
        fingerprint: "capacity-reserved-reply",
        taskId: questioned.task.taskId,
        questionId: "capacity-question",
        answer: { "Which color should be used?": "Blue" },
        now: "2026-09-14T00:00:01.000Z",
      } as const;
      await expect(
        fixture.store.replyToQuestion(replyRequest),
      ).resolves.toMatchObject({
        replayed: false,
        question: { state: "accepted" },
      });
      const durability = (await fixture.store.probe("inspectDurability")) as {
        reservationState: Array<{
          controlReceipts: number;
          controlBytes: number;
        }>;
      };
      expect(durability.reservationState).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            controlReceipts: 1,
            controlBytes: 64 * 1024,
          }),
          expect.objectContaining({
            controlReceipts: 2,
            controlBytes: 128 * 1024,
          }),
        ]),
      );
      const beforeExactReplayProbe = (await fixture.store.probe(
        "inspectPhysicalCapacity",
      )) as {
        databaseBytes: number;
        walBytes: number;
        allocatedDatabaseBytes: number;
        allocatedWalBytes: number;
        pageCount: number;
        freelistCount: number;
        reservedControlBytes: number;
      };
      expect(beforeExactReplayProbe.walBytes).toBeGreaterThan(0);
      const beforeExactReplay = {
        databaseBytes: beforeExactReplayProbe.databaseBytes,
        walBytes: beforeExactReplayProbe.walBytes,
        allocatedDatabaseBytes: beforeExactReplayProbe.allocatedDatabaseBytes,
        allocatedWalBytes: beforeExactReplayProbe.allocatedWalBytes,
        pageCount: beforeExactReplayProbe.pageCount,
        freelistCount: beforeExactReplayProbe.freelistCount,
        reservedControlBytes: beforeExactReplayProbe.reservedControlBytes,
      };
      await expect(
        fixture.store.replyToQuestion(replyRequest),
      ).resolves.toMatchObject({ replayed: true });
      await expect(
        fixture.store.probe("inspectPhysicalCapacity"),
      ).resolves.toMatchObject(beforeExactReplay);
      await expect(
        fixture.store.replyToQuestion({
          ...replyRequest,
          operationId: "capacity-unreserved-second-reply",
          fingerprint: "capacity-unreserved-second-reply",
        }),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      const afterFreshOperationReplay = (await fixture.store.probe(
        "inspectDurability",
      )) as {
        reservationState: Array<{
          controlReceipts: number;
          controlBytes: number;
        }>;
      };
      expect(afterFreshOperationReplay.reservationState).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            controlReceipts: 1,
            controlBytes: 64 * 1024,
          }),
        ]),
      );
      await fixture.store.close();
      reopened = await SqliteDurableAdmissionStore.open({
        databasePath: join(fixture.directory, "store.sqlite"),
        receiptCapacity: 2,
      });
      await expect(
        reopened.cancel({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          expectedRegistryRevision: 0,
          principalId: "principal-a",
          operationId: "capacity-cancel-after-reply",
          fingerprint: "capacity-cancel-after-reply",
          taskId: questioned.task.taskId,
          expectedStates: ["queued", "paused"],
          nextState: "canceled",
          eventType: "canceled",
          now: "2026-09-14T00:00:02.000Z",
          activeElapsedMs: 0,
        }),
      ).resolves.toMatchObject({ task: { state: "stopping" } });
    } finally {
      await reopened?.close();
      await fixture.dispose();
    }
  });

  it("keeps cancellation available when general receipts are saturated", async () => {
    const fixture = await openStore({ receiptCapacity: 1 });
    try {
      const accepted = await fixture.store.submit(submit());
      await expect(
        fixture.store.cancel({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          principalId: "principal-a",
          operationId: "capacity-reserved-cancel",
          fingerprint: "capacity-reserved-cancel",
          taskId: accepted.task.taskId,
          expectedStates: ["queued", "paused"],
          nextState: "canceled",
          eventType: "canceled",
        }),
      ).resolves.toMatchObject({ task: { state: "canceled" } });
    } finally {
      await fixture.dispose();
    }
  });

  it("uses the physical Task reserve for reply at the DB/WAL admission boundary", async () => {
    const fixture = await openStore();
    const databasePath = join(fixture.directory, "store.sqlite");
    let store: SqliteDurableAdmissionStore | undefined = fixture.store;
    try {
      const questioned = await store.submit(
        submit({
          operationId: "physical-reply-submit",
          fingerprint: "physical-reply-submit",
          taskId: "physical-reply-task",
          contextId: "physical-reply-context",
        }),
      );
      const reference = await prepareRunningTask(
        store,
        questioned.task.taskId,
        "physical-reply",
      );
      await store.persistQuestionObservation({
        reference,
        questionId: "physical-reply-question",
        toolUseId: "physical-reply-tool",
        requestId: "physical-reply-request",
        ordinal: 1,
        toolActivity: "none",
        activeElapsedMs: 0,
        schema,
        expiresAt: "2026-09-15T00:00:00.000Z",
        now: "2026-09-14T00:00:00.000Z",
      });
      await store.close();
      store = undefined;

      const checkpointedBytes = (await stat(databasePath)).size;
      store = await SqliteDurableAdmissionStore.open({
        databasePath,
        queueGlobal: 4,
        physicalAdmissionBytes: checkpointedBytes + 16 * 1024,
        physicalControlReserveBytes: 512 * 1024,
        taskControlReserveBytes: 128 * 1024,
      });
      await expect(
        store.submit(
          submit({
            operationId: "physical-reply-rejected-submit",
            taskId: "physical-reply-rejected-task",
            contextId: "physical-reply-rejected-context",
            instruction: "x".repeat(64 * 1024),
            binding: {
              ...submit().binding,
              bindingSnapshotId: "physical-reply-rejected-binding",
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "storage_capacity" });

      await expect(
        store.replyToQuestion({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          expectedRegistryRevision: 0,
          principalId: "principal-a",
          operationId: "physical-reserved-reply",
          fingerprint: "physical-reserved-reply",
          taskId: questioned.task.taskId,
          questionId: "physical-reply-question",
          answer: { "Which color should be used?": "Blue" },
          now: "2026-09-14T00:00:01.000Z",
        }),
      ).resolves.toMatchObject({
        replayed: false,
        question: { state: "accepted" },
      });
      await expect(
        store.probe("inspectPhysicalCapacity"),
      ).resolves.toMatchObject({
        controlReserveBytes: 64 * 1024,
        reservedControlBytes: 64 * 1024,
      });
    } finally {
      await store?.close();
      await fixture.dispose();
    }
  });

  it("keeps acknowledge-interruption available from its per-task reserve", async () => {
    const fixture = await openStore({ receiptCapacity: 1 });
    try {
      const accepted = await fixture.store.submit(submit());
      const reference = await prepareRunningTask(
        fixture.store,
        accepted.task.taskId,
        "acknowledge",
      );
      await fixture.store.recoverExecutions();
      const recovering = await fixture.store.getTask({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        taskId: accepted.task.taskId,
      });
      if (recovering === undefined) throw new Error("Task did not recover");
      await fixture.store.confirmRecoveryStopped({
        evidence: {
          platform: "linux-cgroup-v2",
          reference,
          executionUnitId: "capacity-acknowledge-unit",
          generationSealedAt: "2026-09-14T00:00:02.000Z",
          unitEmptyObservedAt: "2026-09-14T00:00:03.000Z",
        },
        now: "2026-09-14T00:00:04.000Z",
      });
      await expect(
        fixture.store.acknowledgeInterruption({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          expectedRegistryRevision: 0,
          principalId: "principal-a",
          operationId: "capacity-reserved-acknowledgement",
          fingerprint: "capacity-reserved-acknowledgement",
          taskId: accepted.task.taskId,
          expectedRevision: recovering.revision,
          now: "2026-09-14T00:00:05.000Z",
        }),
      ).resolves.toMatchObject({ task: { state: "interrupted" } });
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects physical DB plus WAL admission without evicting an in-period result", async () => {
    const fixture = await openStore();
    const databasePath = join(fixture.directory, "store.sqlite");
    let store: SqliteDurableAdmissionStore | undefined;
    try {
      await fixture.store.close();
      const baselineBytes = (await stat(databasePath)).size;
      store = await SqliteDurableAdmissionStore.open({
        databasePath,
        queueGlobal: 4,
        physicalAdmissionBytes: baselineBytes + 160 * 1024,
        physicalControlReserveBytes: 512 * 1024,
        taskControlReserveBytes: 128 * 1024,
      });
      const retained = await store.submit(
        submit({ instruction: "x".repeat(24 * 1024) }),
      );
      await completeTask(store, retained.task.taskId, "physical-retained");

      await expect(
        store.submit(
          submit({
            operationId: "physical-rejected-submit",
            taskId: "physical-rejected-task",
            contextId: "physical-rejected-context",
            instruction: "x".repeat(64 * 1024),
            binding: {
              ...submit().binding,
              bindingSnapshotId: "physical-rejected-binding",
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "storage_capacity" });
      await expect(
        store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: retained.task.taskId,
        }),
      ).resolves.toMatchObject({ result: { summary: "in-period-result" } });
    } finally {
      await store?.close();
      await fixture.dispose();
    }
  });

  it("reuses checkpointed SQLite freelist pages after terminal expiry", async () => {
    const fixture = await openStore();
    const databasePath = join(fixture.directory, "store.sqlite");
    let store: SqliteDurableAdmissionStore | undefined = fixture.store;
    try {
      const retained = await store.submit(
        submit({
          operationId: "freelist-retained-submit",
          fingerprint: "freelist-retained-submit",
          taskId: "freelist-retained-task",
          contextId: "freelist-retained-context",
          instruction: "p".repeat(60 * 1024),
        }),
      );
      await completeTask(
        store,
        retained.task.taskId,
        "freelist-retained",
        "r".repeat(60 * 1024),
      );
      await store.close();
      store = undefined;

      const compacted = new Database(databasePath);
      try {
        compacted.exec("VACUUM");
      } finally {
        compacted.close();
      }
      const checkpointedBytes = (await stat(databasePath)).size;
      store = await SqliteDurableAdmissionStore.open({
        databasePath,
        queueGlobal: 4,
        physicalAdmissionBytes: checkpointedBytes + 100 * 1024,
        physicalControlReserveBytes: 512 * 1024,
        taskControlReserveBytes: 128 * 1024,
      });
      const replacement = submit({
        operationId: "freelist-replacement-submit",
        fingerprint: "freelist-replacement-submit",
        taskId: "freelist-replacement-task",
        contextId: "freelist-replacement-context",
        instruction: "n".repeat(60 * 1024),
        binding: {
          ...submit().binding,
          bindingSnapshotId: "freelist-replacement-binding",
        },
      });

      await expect(store.submit(replacement)).rejects.toMatchObject({
        code: "storage_capacity",
      });
      await expect(
        store.expireRetainedData({
          asOf: new Date(Date.now() + 31 * 24 * 60 * 60 * 1_000).toISOString(),
        }),
      ).resolves.toMatchObject({ tasksExpired: 1, contextsExpired: 1 });
      const afterExpiry = (await store.probe("inspectPhysicalCapacity")) as {
        freelistCount: number;
      };
      expect(afterExpiry.freelistCount).toBeGreaterThan(0);

      await expect(store.submit(replacement)).resolves.toMatchObject({
        replayed: false,
        task: { taskId: "freelist-replacement-task" },
      });
      const afterReuse = (await store.probe("inspectPhysicalCapacity")) as {
        accountedDatabaseAndWalBytes: number;
        physicalAdmissionBytes: number;
        freelistCount: number;
      };
      expect(afterReuse.accountedDatabaseAndWalBytes).toBeLessThanOrEqual(
        afterReuse.physicalAdmissionBytes,
      );
      expect(afterReuse.freelistCount).toBeLessThan(afterExpiry.freelistCount);
    } finally {
      await store?.close();
      await fixture.dispose();
    }
  });
});
