import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { DurableAgentExecutionService } from "../../src/core/agent-execution-service.js";
import { CursorCodec } from "../../src/core/codec.js";
import { ApplicationError } from "../../src/core/errors.js";
import {
  DurableAdmissionStoreError,
  SqliteDurableAdmissionStore,
  type StoredExecution,
} from "../../src/storage/sqlite-durable-admission-store.js";
import {
  createDurableAdmissionFixture,
  type DurableAdmissionFixture,
} from "../fixtures/durable-admission.js";
import { submit } from "../fixtures/durable-store.js";

const actor = { principalId: "principal-a" };

async function completeTask(
  fixture: DurableAdmissionFixture,
  taskId: string,
): Promise<void> {
  const preparation = await fixture.service.prepareForDispatch(
    taskId,
    "retention-epoch",
  );
  await fixture.service.markExecutionRunning(preparation.reference);
  await fixture.recordObservation(actor, {
    taskId,
    observation: {
      kind: "candidate",
      reference: preparation.reference,
      ordinal: 1,
      finalOrdinal: 1,
      outcome: { kind: "completed", summary: "private-result" },
      sessionReference: null,
    },
  });
  await fixture.store.commitTerminal({
    evidence: {
      platform: "linux-cgroup-v2",
      reference: preparation.reference,
      executionUnitId: "retention-unit",
      generationSealedAt: "2026-09-14T00:00:01.000Z",
      unitEmptyObservedAt: "2026-09-14T00:00:02.000Z",
    },
  });
}

async function completeStoredTask(
  store: SqliteDurableAdmissionStore,
  execution: StoredExecution,
): Promise<void> {
  const reference = {
    executionId: execution.executionId,
    generation: execution.generation,
    daemonEpoch: execution.daemonEpoch,
    launchProfileId: execution.launchProfileId,
    workspaceIdentity: execution.workspaceId,
  };
  await store.markExecutionRunning({ reference });
  await store.commitRuntimeObservation({
    taskId: execution.taskId,
    now: "2026-09-14T00:00:01.000Z",
    observation: {
      kind: "candidate",
      ordinal: 1,
      finalOrdinal: 1,
      reference,
      outcome: { kind: "completed", summary: "private-result" },
      sessionReference: null,
    },
  });
  await store.commitTerminal({
    now: "2026-01-01T00:00:00.000Z",
    evidence: {
      platform: "linux-cgroup-v2",
      reference,
      executionUnitId: "retention-storage-unit",
      generationSealedAt: "2026-09-14T00:00:02.000Z",
      unitEmptyObservedAt: "2026-09-14T00:00:03.000Z",
    },
  });
}

describe("S5 terminal retention expiry", () => {
  let fixture: DurableAdmissionFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it("keeps a fresh task-list snapshot usable after older history expired", async () => {
    fixture = await createDurableAdmissionFixture();
    await fixture.service.submitTask(actor, {
      operationId: "retention-first-submit",
      agentId: "agent-a",
      instruction: "first live task",
    });
    const expiring = await fixture.service.submitTask(actor, {
      operationId: "retention-expiring-submit",
      agentId: "agent-revokable",
      instruction: "private prompt",
    });
    const last = await fixture.service.submitTask(actor, {
      operationId: "retention-last-submit",
      agentId: "agent-a",
      instruction: "last live task",
    });
    await completeTask(fixture, expiring.task.taskId);

    await fixture.store.expireRetainedData({
      asOf: "2026-10-15T00:00:00.000Z",
    });

    const firstPage = await fixture.service.listTasks(actor, { limit: 1 });
    if (firstPage.nextCursor === null) {
      throw new Error("first page did not provide a cursor");
    }

    const secondPage = await fixture.service.listTasks(actor, {
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.tasks.map(({ taskId }) => taskId)).toEqual([
      last.task.taskId,
    ]);
  });

  it("invalidates a task-list cursor when unseen history expires", async () => {
    fixture = await createDurableAdmissionFixture();
    await fixture.service.submitTask(actor, {
      operationId: "stale-first-submit",
      agentId: "agent-a",
      instruction: "first live task",
    });
    const expiring = await fixture.service.submitTask(actor, {
      operationId: "stale-expiring-submit",
      agentId: "agent-revokable",
      instruction: "private prompt",
    });
    await fixture.service.submitTask(actor, {
      operationId: "stale-last-submit",
      agentId: "agent-a",
      instruction: "last live task",
    });

    const firstPage = await fixture.service.listTasks(actor, { limit: 1 });
    if (firstPage.nextCursor === null) {
      throw new Error("first page did not provide a cursor");
    }
    await completeTask(fixture, expiring.task.taskId);
    await fixture.store.expireRetainedData({
      asOf: "2026-10-15T00:00:00.000Z",
    });

    await expect(
      fixture.service.listTasks(actor, {
        limit: 1,
        cursor: firstPage.nextCursor,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "cursor_expired",
    );
  });

  it("invalidates stale event history without poisoning a fresh snapshot", async () => {
    fixture = await createDurableAdmissionFixture();
    const expiring = await fixture.service.submitTask(actor, {
      operationId: "event-expiring-submit",
      agentId: "agent-revokable",
      instruction: "private event history",
    });
    await fixture.service.editTask(actor, {
      operationId: "event-expiring-edit",
      taskId: expiring.task.taskId,
      expectedRevision: expiring.task.revision,
      instruction: "private edited event history",
    });
    await completeTask(fixture, expiring.task.taskId);
    const live = await fixture.service.submitTask(actor, {
      operationId: "event-live-submit",
      agentId: "agent-a",
      instruction: "live event history",
    });
    const stalePage = await fixture.service.getEvents(actor, { limit: 1 });
    if (stalePage.nextCursor === null) {
      throw new Error("event page did not provide a cursor");
    }

    await fixture.store.expireRetainedData({
      asOf: "2026-10-15T00:00:00.000Z",
    });
    await expect(
      fixture.service.getEvents(actor, {
        afterCursor: stalePage.nextCursor,
        limit: 1,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "cursor_expired",
    );
    await fixture.service.editTask(actor, {
      operationId: "event-live-edit",
      taskId: live.task.taskId,
      expectedRevision: live.task.revision,
      instruction: "edited live event history",
    });
    const freshPage = await fixture.service.getEvents(actor, { limit: 1 });
    if (freshPage.nextCursor === null) {
      throw new Error("fresh event page did not provide a cursor");
    }
    await expect(
      fixture.service.getEvents(actor, {
        afterCursor: freshPage.nextCursor,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      events: [{ taskId: live.task.taskId, type: "edited" }],
    });
  });

  it("does not return a cached terminal payload after expiry when storage times out", async () => {
    fixture = await createDurableAdmissionFixture({ requestTimeoutMs: 500 });
    const submitted = await fixture.service.submitTask(actor, {
      operationId: "expired-cache-submit",
      agentId: "agent-revokable",
      instruction: "private-cache-instruction",
    });
    await completeTask(fixture, submitted.task.taskId);

    await expect(
      fixture.service.getTask(actor, { taskId: submitted.task.taskId }),
    ).resolves.toMatchObject({
      state: "completed",
      instruction: "private-cache-instruction",
      result: { summary: "private-result" },
    });

    await fixture.store.expireRetainedData({
      asOf: "2027-01-01T00:00:00.000Z",
    });
    const blocking = fixture.store.probe("block", 1_500).catch(() => undefined);
    await expect(
      fixture.service.getTask(actor, { taskId: submitted.task.taskId }),
    ).rejects.toMatchObject({ code: "observation_unavailable" });
    await blocking;
  });

  it("evicts a cached preterminal payload when verified stop commits terminal state", async () => {
    fixture = await createDurableAdmissionFixture(
      { requestTimeoutMs: 500 },
      {
        stopEvidenceVerifier: {
          verify(value) {
            return value as never;
          },
        },
      },
    );
    const submitted = await fixture.service.submitTask(actor, {
      operationId: "preterminal-cache-submit",
      agentId: "agent-revokable",
      instruction: "private-preterminal-cache-instruction",
    });
    const preparation = await fixture.service.prepareForDispatch(
      submitted.task.taskId,
      "preterminal-cache-epoch",
    );
    await fixture.service.markExecutionRunning(preparation.reference);
    await fixture.recordObservation(actor, {
      taskId: submitted.task.taskId,
      observation: {
        kind: "candidate",
        reference: preparation.reference,
        ordinal: 1,
        finalOrdinal: 1,
        outcome: { kind: "completed", summary: "private-preterminal-result" },
        sessionReference: null,
      },
    });
    await fixture.service.commitVerifiedStop({
      platform: "linux-cgroup-v2",
      reference: preparation.reference,
      executionUnitId: "preterminal-cache-unit",
      generationSealedAt: "2026-09-14T00:00:01.000Z",
      unitEmptyObservedAt: "2026-09-14T00:00:02.000Z",
    });

    await fixture.store.expireRetainedData({
      asOf: "2027-01-01T00:00:00.000Z",
    });
    const blocking = fixture.store.probe("block", 1_500).catch(() => undefined);
    await expect(
      fixture.service.getTask(actor, { taskId: submitted.task.taskId }),
    ).rejects.toMatchObject({ code: "observation_unavailable" });
    await blocking;
  });

  it("evicts a preterminal cache before a timed-out terminal commit completes", async () => {
    fixture = await createDurableAdmissionFixture(
      { requestTimeoutMs: 500 },
      {
        stopEvidenceVerifier: {
          verify(value) {
            return value as never;
          },
        },
      },
    );
    const submitted = await fixture.service.submitTask(actor, {
      operationId: "ambiguous-terminal-cache-submit",
      agentId: "agent-revokable",
      instruction: "private-ambiguous-cache-instruction",
    });
    const preparation = await fixture.service.prepareForDispatch(
      submitted.task.taskId,
      "ambiguous-terminal-cache-epoch",
    );
    await fixture.service.markExecutionRunning(preparation.reference);
    await fixture.recordObservation(actor, {
      taskId: submitted.task.taskId,
      observation: {
        kind: "candidate",
        reference: preparation.reference,
        ordinal: 1,
        finalOrdinal: 1,
        outcome: { kind: "completed", summary: "private-ambiguous-result" },
        sessionReference: null,
      },
    });
    const evidence = {
      platform: "linux-cgroup-v2",
      reference: preparation.reference,
      executionUnitId: "ambiguous-terminal-cache-unit",
      generationSealedAt: "2026-09-14T00:00:01.000Z",
      unitEmptyObservedAt: "2026-09-14T00:00:02.000Z",
    };

    await fixture.store.probe("armCommitBarrier");
    const committing = fixture.service.commitVerifiedStop(evidence);
    try {
      await fixture.store.probe("waitForCommitBarrier");
      await expect(committing).rejects.toMatchObject({
        code: "observation_unavailable",
      });
    } finally {
      await fixture.store.probe("releaseCommitBarrier");
    }
    await expect
      .poll(async () => {
        const task = await fixture?.store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-revokable"],
          taskId: submitted.task.taskId,
        });
        return task?.state;
      })
      .toBe("completed");

    await fixture.store.expireRetainedData({
      asOf: "2027-01-01T00:00:00.000Z",
    });
    const blocking = fixture.store.probe("block", 1_500).catch(() => undefined);
    await expect(
      fixture.service.getTask(actor, { taskId: submitted.task.taskId }),
    ).rejects.toMatchObject({ code: "observation_unavailable" });
    await blocking;
  });

  it("accepts signed pre-v13 task and event cursors as retention sequence zero after restart", async () => {
    fixture = await createDurableAdmissionFixture();
    const first = await fixture.service.submitTask(actor, {
      operationId: "legacy-cursor-first",
      agentId: "agent-a",
      instruction: "first task",
    });
    const second = await fixture.service.submitTask(actor, {
      operationId: "legacy-cursor-second",
      agentId: "agent-a",
      instruction: "second task",
    });
    await fixture.service.editTask(actor, {
      operationId: "legacy-cursor-edit",
      taskId: first.task.taskId,
      expectedRevision: first.task.revision,
      instruction: "first task edited",
    });

    const restarted = new DurableAgentExecutionService(
      fixture.registry,
      fixture.store,
      { cursorSecret: "ap002-fixture-cursor-secret" },
    );
    const codec = new CursorCodec("ap002-fixture-cursor-secret");
    const legacyTaskCursor = codec.encode({
      version: 1,
      kind: "tasks",
      accessScopeId: "scope-a",
      agentId: null,
      state: null,
      afterQueueOrder: first.task.queueOrder,
    });
    const legacyEventCursor = codec.encode({
      version: 1,
      kind: "events",
      accessScopeId: "scope-a",
      taskId: first.task.taskId,
      afterCursor: 1,
    });

    await expect(
      restarted.listTasks(actor, { cursor: legacyTaskCursor, limit: 1 }),
    ).resolves.toMatchObject({ tasks: [{ taskId: second.task.taskId }] });
    await expect(
      restarted.getEvents(actor, {
        taskId: first.task.taskId,
        afterCursor: legacyEventCursor,
        limit: 1,
      }),
    ).resolves.toMatchObject({ events: [{ type: "edited" }] });
  });

  it("retains in-period data then tombstones the operation without private payload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentport-s5-retention-"));
    const databasePath = join(directory, "agentport.sqlite");
    let store: SqliteDurableAdmissionStore | undefined;
    try {
      store = await SqliteDurableAdmissionStore.open({ databasePath });
      const accepted = await store.submit(
        submit({
          operationId: "private-submit",
          fingerprint: "private-fingerprint",
          taskId: "private-task",
          contextId: "private-context",
          instruction: "private-prompt-sentinel",
        }),
      );
      const execution = await store.claimAndPrepare({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        expectedRegistryRevision: 0,
        executionId: "private-execution",
        taskId: accepted.task.taskId,
        generation: "private-generation",
        daemonEpoch: "private-epoch",
        dispatchIntent: true,
        binding: {
          ...submit().binding,
          bindingSnapshotId: "private-dispatch-binding",
          accessScopeId: "scope-a",
          agentId: "agent-a",
          createdAt: "2026-09-14T00:00:00.000Z",
        },
      });
      await completeStoredTask(store, execution);

      const withinRetention = await store.expireRetainedData({
        asOf: "2026-01-30T23:59:59.999Z",
      });
      expect(withinRetention.tasksExpired).toBe(0);
      await expect(
        store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: "private-task",
        }),
      ).resolves.toMatchObject({
        instruction: "private-prompt-sentinel",
        result: { summary: "private-result" },
      });
      await store.close();
      store = await SqliteDurableAdmissionStore.open({ databasePath });
      await expect(
        store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: "private-task",
        }),
      ).resolves.toMatchObject({
        taskId: "private-task",
        instruction: "private-prompt-sentinel",
        result: { summary: "private-result" },
      });
      await expect(
        store.lookupReceipt({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          expectedAgentId: "agent-a",
          operationId: "private-submit",
          operationType: "submit",
          fingerprint: "private-fingerprint",
        }),
      ).resolves.toMatchObject({
        taskId: "private-task",
        instruction: "private-prompt-sentinel",
        result: null,
      });
      const inPeriodEvents = await store.getEvents({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        taskId: "private-task",
        limit: 100,
      });
      expect(inPeriodEvents.events.map(({ taskId }) => taskId)).toContain(
        "private-task",
      );

      const expired = await store.expireRetainedData({
        asOf: "2026-01-31T00:00:00.000Z",
      });
      expect(expired).toMatchObject({
        contextsExpired: 1,
        tasksExpired: 1,
        receiptsTombstoned: 1,
      });
      await expect(
        store.lookupReceipt({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          expectedAgentId: "agent-a",
          operationId: "private-submit",
          operationType: "submit",
          fingerprint: "private-fingerprint",
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DurableAdmissionStoreError &&
          error.code === "result_expired",
      );
      await expect(
        store.submit(
          submit({
            operationId: "replacement-operation",
            fingerprint: "replacement-fingerprint",
            taskId: "private-task",
            contextId: "replacement-context",
            instruction: "must not reopen expired identity",
          }),
        ),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DurableAdmissionStoreError &&
          error.code === "result_expired",
      );

      await store.close();
      store = undefined;
      const inspected = new Database(databasePath, { fileMustExist: true });
      try {
        expect(
          inspected
            .prepare(
              "SELECT result_json AS result,expired_at AS expiredAt FROM operation_receipts WHERE operation_id='private-submit'",
            )
            .get(),
        ).toEqual({
          result: '{"taskId":"private-task"}',
          expiredAt: expired.asOf,
        });
        expect(
          inspected
            .prepare("SELECT COUNT(*) AS count FROM task_expiry_markers")
            .get(),
        ).toEqual({ count: 1 });
        expect(
          inspected.prepare("SELECT COUNT(*) AS count FROM tasks").get(),
        ).toEqual({ count: 0 });
        expect(
          inspected
            .prepare("SELECT COUNT(*) AS count FROM execution_terminals")
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        inspected.close();
      }

      store = await SqliteDurableAdmissionStore.open({ databasePath });
      await expect(
        store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: "private-task",
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DurableAdmissionStoreError &&
          error.code === "result_expired",
      );
      await expect(
        store.expireRetainedData({
          asOf: "2026-02-01T00:00:00.000Z",
        }),
      ).resolves.toMatchObject({ tasksExpired: 0, contextsExpired: 0 });
    } finally {
      await store?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs bounded retention from the internal maintenance scheduler", async () => {
    const scheduled = await import("../fixtures/durable-store.js").then(
      ({ openStore }) =>
        openStore({
          terminalRetentionDays: 1,
          retentionSweepIntervalMs: 10,
        }),
    );
    try {
      await scheduled.store.submit(
        submit({
          operationId: "scheduled-submit",
          fingerprint: "scheduled-fingerprint",
          taskId: "scheduled-task",
          contextId: "scheduled-context",
          now: "2026-01-01T00:00:00.000Z",
        }),
      );
      await scheduled.store.cancel({
        accessScopeId: "scope-a",
        operationId: "scheduled-cancel",
        fingerprint: "scheduled-cancel-fingerprint",
        taskId: "scheduled-task",
        principalId: "principal-a",
        allowedAgentIds: ["agent-a"],
        expectedStates: ["queued"],
        nextState: "canceled",
        eventType: "canceled",
        now: "2026-01-01T00:00:01.000Z",
      });

      await expect
        .poll(
          async () => {
            try {
              await scheduled.store.getTask({
                accessScopeId: "scope-a",
                allowedAgentIds: ["agent-a"],
                taskId: "scheduled-task",
              });
              return "retained";
            } catch (error) {
              return error instanceof DurableAdmissionStoreError
                ? error.code
                : "unexpected";
            }
          },
          { timeout: 2_000 },
        )
        .toBe("result_expired");
    } finally {
      await scheduled.dispose();
    }
  });
});
