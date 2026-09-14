import { rm } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { ApplicationError } from "../../src/core/errors.js";
import {
  DurableAdmissionStoreError,
  SqliteDurableAdmissionStore,
} from "../../src/storage/sqlite-durable-admission-store.js";
import {
  createDurableAdmissionFixture,
  type DurableAdmissionFixture,
} from "../fixtures/durable-admission.js";
import { openStore, submit } from "../fixtures/durable-store.js";

const actor = { principalId: "principal-a" };

function dispatchRequest(taskId: string, suffix: string) {
  return {
    accessScopeId: "scope-a",
    allowedAgentIds: ["agent-a"],
    expectedRegistryRevision: 0,
    executionId: `retention-race-execution-${suffix}`,
    taskId,
    generation: `retention-race-generation-${suffix}`,
    daemonEpoch: `retention-race-epoch-${suffix}`,
    dispatchIntent: true,
    binding: {
      ...submit().binding,
      bindingSnapshotId: `retention-race-binding-${suffix}`,
      accessScopeId: "scope-a",
      agentId: "agent-a",
      createdAt: "2026-09-14T00:00:00.000Z",
    },
  };
}

async function prepareTerminalCandidate(
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
  await store.commitRuntimeObservation({
    taskId,
    now: "2026-09-14T00:00:01.000Z",
    observation: {
      kind: "candidate",
      ordinal: 1,
      finalOrdinal: 1,
      reference,
      outcome: { kind: "completed", summary: "private-result-sentinel" },
      sessionReference: null,
    },
  });
  return {
    evidence: {
      platform: "linux-cgroup-v2" as const,
      reference,
      executionUnitId: `retention-race-unit-${suffix}`,
      generationSealedAt: "2026-09-14T00:00:02.000Z",
      unitEmptyObservedAt: "2026-09-14T00:00:03.000Z",
    },
  };
}

async function completeTask(
  store: SqliteDurableAdmissionStore,
  taskId: string,
  suffix: string,
) {
  const { evidence } = await prepareTerminalCandidate(store, taskId, suffix);
  await store.commitTerminal({ evidence });
}

async function completeServiceTask(
  fixture: DurableAdmissionFixture,
  taskId: string,
): Promise<void> {
  const preparation = await fixture.service.prepareForDispatch(
    taskId,
    "retention-cursor-epoch",
  );
  await fixture.service.markExecutionRunning(preparation.reference);
  await fixture.recordObservation(actor, {
    taskId,
    observation: {
      kind: "candidate",
      reference: preparation.reference,
      ordinal: 1,
      finalOrdinal: 1,
      outcome: { kind: "completed", summary: "cursor race result" },
      sessionReference: null,
    },
  });
  await fixture.store.commitTerminal({
    evidence: {
      platform: "linux-cgroup-v2",
      reference: preparation.reference,
      executionUnitId: "retention-cursor-unit",
      generationSealedAt: "2026-09-14T00:00:01.000Z",
      unitEmptyObservedAt: "2026-09-14T00:00:02.000Z",
    },
  });
}

function expiryTime(): string {
  return new Date(Date.now() + 31 * 24 * 60 * 60 * 1_000).toISOString();
}

describe("S5 retention cleanup races", () => {
  it("rolls back the expiry marker and private-payload deletion when cleanup faults before commit", async () => {
    const fixture = await openStore();
    const databasePath = join(fixture.directory, "store.sqlite");
    let store: SqliteDurableAdmissionStore | undefined = fixture.store;
    const request = submit({
      operationId: "retention-fault-submit",
      fingerprint: "retention-fault-fingerprint",
      taskId: "retention-fault-task",
      contextId: "retention-fault-context",
      instruction: "private-prompt-sentinel",
    });
    try {
      const accepted = await store.submit(request);
      await completeTask(store, accepted.task.taskId, "fault");

      await store.probe("failNextCommit");
      await expect(
        store.expireRetainedData({ asOf: expiryTime() }),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      await expect(
        store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: accepted.task.taskId,
        }),
      ).resolves.toMatchObject({
        instruction: "private-prompt-sentinel",
        result: { summary: "private-result-sentinel" },
      });

      await store.close();
      store = undefined;
      const inspected = new Database(databasePath, { fileMustExist: true });
      try {
        expect(
          inspected
            .prepare("SELECT COUNT(*) AS count FROM task_expiry_markers")
            .get(),
        ).toEqual({ count: 0 });
        expect(
          inspected.prepare("SELECT COUNT(*) AS count FROM tasks").get(),
        ).toEqual({ count: 1 });
      } finally {
        inspected.close();
      }

      store = await SqliteDurableAdmissionStore.open({ databasePath });
      await expect(
        store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: accepted.task.taskId,
        }),
      ).resolves.toMatchObject({
        instruction: "private-prompt-sentinel",
        result: { summary: "private-result-sentinel" },
      });
    } finally {
      await store?.close();
      await rm(fixture.directory, { force: true, recursive: true });
    }
  });

  it("linearizes cleanup ahead of an identical retry and keeps the expired winner after restart", async () => {
    const fixture = await openStore();
    const databasePath = join(fixture.directory, "store.sqlite");
    let store = fixture.store;
    const request = submit({
      operationId: "retention-retry-submit",
      fingerprint: "retention-retry-fingerprint",
      taskId: "retention-retry-task",
      contextId: "retention-retry-context",
      instruction: "private-retry-prompt",
    });
    try {
      const accepted = await store.submit(request);
      await completeTask(store, accepted.task.taskId, "retry");

      await store.probe("armCommitBarrier");
      const cleanupPromise = store.expireRetainedData({ asOf: expiryTime() });
      await store.probe("waitForCommitBarrier");
      const retryPromise = store.submit(request);
      await store.probe("releaseCommitBarrier");
      const [cleanup, retry] = await Promise.allSettled([
        cleanupPromise,
        retryPromise,
      ]);
      expect(cleanup).toMatchObject({
        status: "fulfilled",
        value: { tasksExpired: 1, receiptsTombstoned: 1 },
      });
      expect(retry).toMatchObject({
        status: "rejected",
        reason: { code: "result_expired" },
      });

      await store.close();
      store = await SqliteDurableAdmissionStore.open({ databasePath });
      await expect(store.submit(request)).rejects.toMatchObject({
        code: "result_expired",
      });
      await expect(
        store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: accepted.task.taskId,
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DurableAdmissionStoreError &&
          error.code === "result_expired",
      );
    } finally {
      await store.close();
      await rm(fixture.directory, { force: true, recursive: true });
    }
  });

  it("linearizes cleanup before a concurrent terminal commit without expiring the nonterminal candidate", async () => {
    const fixture = await openStore();
    const store = fixture.store;
    const request = submit({
      operationId: "retention-terminal-submit",
      fingerprint: "retention-terminal-fingerprint",
      taskId: "retention-terminal-task",
      contextId: "retention-terminal-context",
      instruction: "private-terminal-prompt",
    });
    try {
      const accepted = await store.submit(request);
      const { evidence } = await prepareTerminalCandidate(
        store,
        accepted.task.taskId,
        "terminal",
      );

      const [cleanup, terminal] = await Promise.all([
        store.expireRetainedData({ asOf: expiryTime() }),
        store.commitTerminal({ evidence }),
      ]);
      expect(cleanup).toMatchObject({ tasksExpired: 0, contextsExpired: 0 });
      expect(terminal).toMatchObject({
        replayed: false,
        task: { state: "completed", instruction: "private-terminal-prompt" },
      });
      await expect(store.submit(request)).resolves.toMatchObject({
        replayed: true,
        task: { taskId: accepted.task.taskId },
      });
    } finally {
      await store.close();
      await rm(fixture.directory, { force: true, recursive: true });
    }
  });

  it("expires a terminal commit that wins the retention race and preserves that winner after restart", async () => {
    const fixture = await openStore();
    const databasePath = join(fixture.directory, "store.sqlite");
    let store = fixture.store;
    const request = submit({
      operationId: "retention-terminal-winner-submit",
      fingerprint: "retention-terminal-winner-fingerprint",
      taskId: "retention-terminal-winner-task",
      contextId: "retention-terminal-winner-context",
      instruction: "private-terminal-winner-prompt",
    });
    try {
      const accepted = await store.submit(request);
      const { evidence } = await prepareTerminalCandidate(
        store,
        accepted.task.taskId,
        "terminal-winner",
      );

      await store.probe("armCommitBarrier");
      const terminal = store.commitTerminal({ evidence });
      await store.probe("waitForCommitBarrier");
      const cleanup = store.expireRetainedData({ asOf: expiryTime() });
      await store.probe("releaseCommitBarrier");
      await expect(terminal).resolves.toMatchObject({
        replayed: false,
        task: { state: "completed" },
      });
      await expect(cleanup).resolves.toMatchObject({
        tasksExpired: 1,
        contextsExpired: 1,
      });

      await store.close();
      store = await SqliteDurableAdmissionStore.open({ databasePath });
      await expect(store.submit(request)).rejects.toMatchObject({
        code: "result_expired",
      });
    } finally {
      await store.close();
      await rm(fixture.directory, { force: true, recursive: true });
    }
  });

  it("makes a cursor read before cleanup fail closed after cleanup wins", async () => {
    let fixture: DurableAdmissionFixture | undefined;
    try {
      fixture = await createDurableAdmissionFixture();
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "retention-cursor-race-submit",
        agentId: "agent-a",
        instruction: "cursor must not bridge erased history",
      });
      await fixture.service.editTask(actor, {
        operationId: "retention-cursor-race-edit",
        taskId: submitted.task.taskId,
        expectedRevision: submitted.task.revision,
        instruction: "cursor event before cleanup",
      });
      const snapshot = await fixture.service.getEvents(actor, { limit: 1 });
      if (snapshot.nextCursor === null) {
        throw new Error("event snapshot did not produce a cursor");
      }
      await completeServiceTask(fixture, submitted.task.taskId);

      await fixture.store.probe("armCommitBarrier");
      const cleanup = fixture.store.expireRetainedData({
        asOf: "2026-10-15T00:00:00.000Z",
      });
      await fixture.store.probe("waitForCommitBarrier");
      const cursorRead = fixture.service.getEvents(actor, {
        afterCursor: snapshot.nextCursor,
        limit: 1,
      });
      await fixture.store.probe("releaseCommitBarrier");
      await expect(cleanup).resolves.toMatchObject({ tasksExpired: 1 });
      await expect(cursorRead).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof ApplicationError && error.code === "cursor_expired",
      );
    } finally {
      await fixture?.close();
    }
  });

  it("keeps the Context when cleanup wins before its final terminal commit, then expires it after that commit and restart", async () => {
    const fixture = await openStore();
    const databasePath = join(fixture.directory, "store.sqlite");
    let store = fixture.store;
    const firstRequest = submit({
      operationId: "retention-context-first-submit",
      fingerprint: "retention-context-first-fingerprint",
      taskId: "retention-context-first-task",
      contextId: "retention-context-id",
    });
    const finalRequest = submit({
      operationId: "retention-context-final-submit",
      fingerprint: "retention-context-final-fingerprint",
      taskId: "retention-context-final-task",
      contextId: "retention-context-id",
      existingContextId: "retention-context-id",
      binding: {
        ...submit().binding,
        bindingSnapshotId: "retention-context-final-binding",
      },
    });
    try {
      const first = await store.submit(firstRequest);
      const final = await store.submit(finalRequest);
      await completeTask(store, first.task.taskId, "context-first");
      const { evidence } = await prepareTerminalCandidate(
        store,
        final.task.taskId,
        "context-final",
      );

      await store.probe("armCommitBarrier");
      const cleanupBeforeTerminal = store.expireRetainedData({
        asOf: expiryTime(),
      });
      await store.probe("waitForCommitBarrier");
      const terminalCommit = store.commitTerminal({ evidence });
      await store.probe("releaseCommitBarrier");
      await expect(cleanupBeforeTerminal).resolves.toMatchObject({
        tasksExpired: 1,
        contextsExpired: 0,
      });
      await expect(terminalCommit).resolves.toMatchObject({
        task: { state: "completed" },
      });
      await expect(
        store.expireRetainedData({ asOf: expiryTime() }),
      ).resolves.toMatchObject({
        tasksExpired: 1,
        contextsExpired: 1,
      });

      await store.close();
      store = await SqliteDurableAdmissionStore.open({ databasePath });
      await expect(
        store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: final.task.taskId,
        }),
      ).rejects.toMatchObject({ code: "result_expired" });
      await expect(store.probe("inspectDurability")).resolves.toMatchObject({
        contexts: 0,
      });
    } finally {
      await store.close();
      await rm(fixture.directory, { force: true, recursive: true });
    }
  });
});
