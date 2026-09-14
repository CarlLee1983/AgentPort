import { afterEach, describe, expect, it } from "vitest";

import { ApplicationError } from "../../src/core/errors.js";
import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";
import {
  createDurableAdmissionFixture,
  type DurableAdmissionFixture,
} from "../fixtures/durable-admission.js";

const actor = { principalId: "principal-a" };

async function completeTask(
  fixture: DurableAdmissionFixture,
  taskId: string,
): Promise<void> {
  const preparation = await fixture.service.prepareForDispatch(
    taskId,
    "context-retention-epoch",
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
      executionUnitId: "context-retention-unit",
      generationSealedAt: "2026-09-14T00:00:01.000Z",
      unitEmptyObservedAt: "2026-09-14T00:00:02.000Z",
    },
  });
}

describe("S5 Context retention", () => {
  let fixture: DurableAdmissionFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it("keeps a Context while a related Task remains queryable, then retires it after the final Task expires", async () => {
    fixture = await createDurableAdmissionFixture();
    const first = await fixture.service.submitTask(actor, {
      operationId: "context-retention-first-submit",
      agentId: "agent-a",
      instruction: "expire only when this Context has no remaining Task",
    });
    const final = await fixture.service.submitTask(actor, {
      operationId: "context-retention-final-submit",
      agentId: "agent-a",
      contextId: first.task.contextId,
      instruction: "keep the Context queryable",
    });
    await completeTask(fixture, first.task.taskId);

    await expect(
      fixture.store.expireRetainedData({
        asOf: "2026-10-15T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ contextsExpired: 0, tasksExpired: 1 });
    await expect(
      fixture.service.getTask(actor, { taskId: first.task.taskId }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "result_expired",
    );
    await expect(
      fixture.service.getTask(actor, { taskId: final.task.taskId }),
    ).resolves.toMatchObject({ state: "queued" });
    await expect(
      fixture.store.probe("inspectDurability"),
    ).resolves.toMatchObject({
      contexts: 1,
    });

    await completeTask(fixture, final.task.taskId);

    await expect(
      fixture.store.expireRetainedData({
        asOf: "2026-10-15T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ contextsExpired: 1, tasksExpired: 1 });
    await expect(
      fixture.service.getTask(actor, { taskId: final.task.taskId }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "result_expired",
    );
    await expect(
      fixture.store.probe("inspectDurability"),
    ).resolves.toMatchObject({
      contexts: 0,
    });
  });

  it("does not select nonterminal, paused, recovering, stopping, held, or quarantined Tasks for expiry", async () => {
    fixture = await createDurableAdmissionFixture();
    const recovering = await fixture.service.submitTask(actor, {
      operationId: "context-retention-recovering-submit",
      agentId: "agent-revokable",
      instruction: "retain its quarantined recovery claim",
    });
    const recoveringPreparation = await fixture.service.prepareForDispatch(
      recovering.task.taskId,
      "context-retention-recovering-epoch",
    );
    await fixture.service.markExecutionRunning(recoveringPreparation.reference);
    await fixture.service.initializeAfterRestart();

    const stopping = await fixture.service.submitTask(actor, {
      operationId: "context-retention-stopping-submit",
      agentId: "agent-a",
      instruction: "retain its held stopping claim",
    });
    const stoppingPreparation = await fixture.service.prepareForDispatch(
      stopping.task.taskId,
      "context-retention-stopping-epoch",
    );
    await fixture.service.markExecutionRunning(stoppingPreparation.reference);
    await fixture.service.cancelTask(actor, {
      operationId: "context-retention-stopping-cancel",
      taskId: stopping.task.taskId,
    });

    const pausedPredecessor = await fixture.service.submitTask(actor, {
      operationId: "context-retention-paused-predecessor-submit",
      agentId: "agent-a",
      instruction: "cancel to block the follow-up",
    });
    const paused = await fixture.service.submitTask(actor, {
      operationId: "context-retention-paused-submit",
      agentId: "agent-a",
      contextId: pausedPredecessor.task.contextId,
      instruction: "remain paused",
    });
    await fixture.service.cancelTask(actor, {
      operationId: "context-retention-paused-predecessor-cancel",
      taskId: pausedPredecessor.task.taskId,
    });
    const queued = await fixture.service.submitTask(actor, {
      operationId: "context-retention-queued-submit",
      agentId: "agent-revokable",
      instruction: "remain nonterminal",
    });

    await expect(
      fixture.store.expireRetainedData({
        asOf: "2026-10-15T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ contextsExpired: 0, tasksExpired: 1 });
    await expect(
      fixture.service.getTask(actor, { taskId: pausedPredecessor.task.taskId }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "result_expired",
    );
    await expect(
      fixture.service.getTask(actor, { taskId: queued.task.taskId }),
    ).resolves.toMatchObject({ state: "queued" });
    await expect(
      fixture.service.getTask(actor, { taskId: paused.task.taskId }),
    ).resolves.toMatchObject({ state: "paused" });
    await expect(
      fixture.service.getTask(actor, { taskId: stopping.task.taskId }),
    ).resolves.toMatchObject({
      state: "stopping",
      execution: { quarantined: false },
    });
    await expect(
      fixture.store.getExecution({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a", "agent-revokable"],
        taskId: stopping.task.taskId,
      }),
    ).resolves.toMatchObject({ state: "stopping", workspaceClaim: "held" });
    await expect(
      fixture.service.getTask(actor, { taskId: recovering.task.taskId }),
    ).resolves.toMatchObject({
      state: "recovering",
      execution: { quarantined: true },
    });
    await expect(
      fixture.store.getExecution({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a", "agent-revokable"],
        taskId: recovering.task.taskId,
      }),
    ).resolves.toMatchObject({
      state: "recovering",
      workspaceClaim: "quarantined",
    });
    await expect(
      fixture.store.probe("inspectDurability"),
    ).resolves.toMatchObject({
      contexts: 4,
    });
  });

  it("makes an acknowledged interruption retention-eligible while starting, running, and awaiting-input work remains protected", async () => {
    fixture = await createDurableAdmissionFixture();
    const interrupted = await fixture.service.submitTask(actor, {
      operationId: "context-retention-interrupted-submit",
      agentId: "agent-revokable",
      instruction: "becomes eligible only after acknowledgement",
    });
    const interruptedPreparation = await fixture.service.prepareForDispatch(
      interrupted.task.taskId,
      "context-retention-interrupted-epoch",
    );
    await fixture.service.markExecutionRunning(
      interruptedPreparation.reference,
    );
    await fixture.store.recoverExecutions();
    const recovering = await fixture.service.getTask(actor, {
      taskId: interrupted.task.taskId,
    });
    await fixture.store.confirmRecoveryStopped({
      evidence: {
        platform: "linux-cgroup-v2",
        reference: interruptedPreparation.reference,
        executionUnitId: "context-retention-interrupted-unit",
        generationSealedAt: "2026-09-14T00:00:01.000Z",
        unitEmptyObservedAt: "2026-09-14T00:00:02.000Z",
      },
      now: "2026-09-14T00:00:03.000Z",
    });
    await fixture.service.acknowledgeInterruption(actor, {
      operationId: "context-retention-interrupted-acknowledgement",
      taskId: interrupted.task.taskId,
      expectedRevision: recovering.revision,
    });

    const starting = await fixture.service.submitTask(actor, {
      operationId: "context-retention-starting-submit",
      agentId: "agent-a",
      instruction: "must remain starting",
    });
    await fixture.service.prepareForDispatch(
      starting.task.taskId,
      "context-retention-starting-epoch",
    );
    const running = await fixture.service.submitTask(actor, {
      operationId: "context-retention-running-submit",
      agentId: "agent-revokable",
      instruction: "must remain running",
    });
    const runningPreparation = await fixture.service.prepareForDispatch(
      running.task.taskId,
      "context-retention-running-epoch",
    );
    await fixture.service.markExecutionRunning(runningPreparation.reference);
    await expect(
      fixture.store.expireRetainedData({
        asOf: "2026-10-15T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ tasksExpired: 1, contextsExpired: 1 });
    await expect(
      fixture.service.getTask(actor, { taskId: interrupted.task.taskId }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "result_expired",
    );
    await expect(
      fixture.service.getTask(actor, { taskId: starting.task.taskId }),
    ).resolves.toMatchObject({ state: "starting" });
    await expect(
      fixture.service.getTask(actor, { taskId: running.task.taskId }),
    ).resolves.toMatchObject({ state: "running" });
    await fixture.store.close();
    const restarted = await SqliteDurableAdmissionStore.open({
      databasePath: fixture.databasePath,
    });
    try {
      await expect(
        restarted.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a", "agent-revokable", "agent-other"],
          taskId: interrupted.task.taskId,
        }),
      ).rejects.toMatchObject({ code: "result_expired" });
    } finally {
      await restarted.close();
    }
  });

  it("does not expire an awaiting-input Task or its Context", async () => {
    fixture = await createDurableAdmissionFixture();
    const submitted = await fixture.service.submitTask(actor, {
      operationId: "context-retention-awaiting-input-submit",
      agentId: "agent-a",
      instruction: "must remain awaiting input",
    });
    const preparation = await fixture.service.prepareForDispatch(
      submitted.task.taskId,
      "context-retention-awaiting-input-epoch",
    );
    await fixture.service.markExecutionRunning(preparation.reference);
    await fixture.store.persistQuestionObservation({
      reference: preparation.reference,
      questionId: "context-retention-question",
      toolUseId: "context-retention-tool-use",
      requestId: "context-retention-request",
      ordinal: 1,
      toolActivity: "none",
      activeElapsedMs: 0,
      schema: [
        {
          question: "Continue?",
          header: "Confirm",
          options: [
            { label: "Yes", description: "Continue execution" },
            { label: "No", description: "Stop execution" },
          ],
          multiSelect: false,
        },
      ],
      expiresAt: "2026-09-15T00:00:00.000Z",
      now: "2026-09-14T00:00:00.000Z",
    });

    await expect(
      fixture.store.expireRetainedData({
        asOf: "2026-10-15T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ tasksExpired: 0, contextsExpired: 0 });
    await expect(
      fixture.service.getTask(actor, { taskId: submitted.task.taskId }),
    ).resolves.toMatchObject({ state: "awaiting_input" });
  });
});
