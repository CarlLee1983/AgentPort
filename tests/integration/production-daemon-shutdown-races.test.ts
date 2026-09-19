import { describe, expect, it, vi } from "vitest";

import type {
  ExecutionSupervisor,
  VerifiedStopEvidence,
} from "../../src/core/execution-supervisor.js";
import type { ExecutionReference } from "../../src/core/types.js";
import { ControlledRuntimeDispatcher } from "../../src/dispatcher/controlled-runtime-dispatcher.js";
import type { TerminalStopEvidence } from "../../src/storage/sqlite-durable-admission-store.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

const actor = { principalId: "principal-a" };

async function startExecution(
  fixture: Awaited<ReturnType<typeof createDurableAdmissionFixture>>,
  taskId: string,
): Promise<void> {
  const supervisor: ExecutionSupervisor = {
    start: (reference) =>
      Promise.resolve({
        kind: "started",
        executionUnitId: `unit-${reference.executionId}`,
      }),
    reconcile: () => Promise.resolve({ kind: "indeterminate" }),
    revokeAndStop: () => Promise.resolve({ kind: "indeterminate" }),
  };
  await expect(
    new ControlledRuntimeDispatcher(
      fixture.service,
      { dispatchAuthority: () => Promise.resolve("shutdown-test-epoch") },
      supervisor,
    ).dispatch(taskId),
  ).resolves.toEqual({ kind: "started" });
}

function verifier(authentic: WeakSet<object>) {
  return {
    verify(value: unknown): TerminalStopEvidence | undefined {
      if (
        typeof value !== "object" ||
        value === null ||
        !authentic.has(value)
      ) {
        return undefined;
      }
      const evidence = value as VerifiedStopEvidence;
      return {
        platform: evidence.platform,
        reference: { ...evidence.reference },
        executionUnitId: evidence.executionUnitId,
        generationSealedAt: evidence.generationSealedAt,
        unitEmptyObservedAt: evidence.unitEmptyObservedAt,
      };
    },
  };
}

describe("production daemon shutdown convergence", () => {
  it("rolls back a claim at the durable shutdown fence and never launches", async () => {
    const fixture = await createDurableAdmissionFixture();
    let barrierArmed = false;
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "daemon-shutdown-dispatch-race",
        agentId: "agent-a",
        instruction: "the lifecycle fence must win before claim commit",
      });
      let dispatchOpen = true;
      const start = vi.fn(() => Promise.resolve({ kind: "pending" as const }));
      const revokeAndStop = vi.fn(() =>
        Promise.resolve({ kind: "indeterminate" as const }),
      );
      const dispatcher = new ControlledRuntimeDispatcher(
        fixture.service,
        { dispatchAuthority: () => Promise.resolve("shutdown-race-epoch") },
        {
          start,
          reconcile: () => Promise.resolve({ kind: "indeterminate" }),
          revokeAndStop,
        },
        undefined,
        { isOpen: () => dispatchOpen },
      );
      await fixture.store.probe("armCommitBarrier");
      barrierArmed = true;
      const dispatching = dispatcher.dispatch(submitted.task.taskId);
      await fixture.store.probe("waitForCommitBarrier");
      dispatchOpen = false;
      fixture.store.closeDispatchAdmission();
      await fixture.store.probe("releaseCommitBarrier");
      barrierArmed = false;

      await expect(dispatching).resolves.toEqual({ kind: "unavailable" });
      expect(start).not.toHaveBeenCalled();
      expect(revokeAndStop).not.toHaveBeenCalled();
      await expect(
        fixture.service.getTask(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        state: "queued",
        execution: null,
      });
    } finally {
      if (barrierArmed) {
        await fixture.store
          .probe("releaseCommitBarrier")
          .catch(() => undefined);
      }
      await fixture.close();
    }
  });

  it("lets a claim that acquired the commit fence finish before closing admission", async () => {
    const fixture = await createDurableAdmissionFixture();
    let barrierArmed = false;
    try {
      const winning = await fixture.service.submitTask(actor, {
        operationId: "daemon-shutdown-claim-wins",
        agentId: "agent-a",
        instruction: "linearize this claim before shutdown",
      });
      const later = await fixture.service.submitTask(actor, {
        operationId: "daemon-shutdown-later-claim",
        agentId: "agent-revokable",
        instruction: "remain outside the closed dispatch boundary",
      });
      let dispatchOpen = true;
      const start = vi.fn(() => Promise.resolve({ kind: "pending" as const }));
      const revokeAndStop = vi.fn(() =>
        Promise.resolve({ kind: "indeterminate" as const }),
      );
      const dispatcher = new ControlledRuntimeDispatcher(
        fixture.service,
        { dispatchAuthority: () => Promise.resolve("claim-wins-epoch") },
        {
          start,
          reconcile: () => Promise.resolve({ kind: "indeterminate" }),
          revokeAndStop,
        },
        undefined,
        { isOpen: () => dispatchOpen },
      );
      await fixture.store.probe("armDispatchCommitBarrier");
      barrierArmed = true;
      const dispatching = dispatcher.dispatch(winning.task.taskId);
      await fixture.store.probe("waitForDispatchCommitBarrier");
      dispatchOpen = false;
      fixture.store.closeDispatchAdmission();
      await fixture.store.probe("releaseDispatchCommitBarrier");
      barrierArmed = false;

      await expect(dispatching).resolves.toEqual({ kind: "indeterminate" });
      expect(start).not.toHaveBeenCalled();
      expect(revokeAndStop).toHaveBeenCalledTimes(1);
      await expect(
        fixture.service.getTask(actor, { taskId: winning.task.taskId }),
      ).resolves.toMatchObject({
        state: "recovering",
        execution: { quarantined: true },
      });
      await expect(
        fixture.service.prepareForDispatch(
          later.task.taskId,
          "closed-admission-epoch",
        ),
      ).rejects.toMatchObject({ code: "invalid_state" });
    } finally {
      if (barrierArmed) {
        await fixture.store
          .probe("releaseDispatchCommitBarrier")
          .catch(() => undefined);
      }
      await fixture.close();
    }
  });

  it("releases a shutdown-marked commit fence after claim rollback", async () => {
    const fixture = await createDurableAdmissionFixture();
    let barrierArmed = false;
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "daemon-shutdown-claim-rollback",
        agentId: "agent-a",
        instruction: "roll back after acquiring the dispatch commit fence",
      });
      let dispatchOpen = true;
      const start = vi.fn(() => Promise.resolve({ kind: "pending" as const }));
      const dispatcher = new ControlledRuntimeDispatcher(
        fixture.service,
        { dispatchAuthority: () => Promise.resolve("claim-rollback-epoch") },
        {
          start,
          reconcile: () => Promise.resolve({ kind: "indeterminate" }),
          revokeAndStop: () => Promise.resolve({ kind: "indeterminate" }),
        },
        undefined,
        { isOpen: () => dispatchOpen },
      );
      await fixture.store.probe("armDispatchCommitRollback");
      barrierArmed = true;
      const dispatching = dispatcher.dispatch(submitted.task.taskId);
      await fixture.store.probe("waitForDispatchCommitBarrier");
      dispatchOpen = false;
      fixture.store.closeDispatchAdmission();
      await fixture.store.probe("releaseDispatchCommitBarrier");
      barrierArmed = false;

      await expect(dispatching).resolves.toEqual({ kind: "unavailable" });
      expect(start).not.toHaveBeenCalled();
      await expect(
        fixture.service.getTask(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({ state: "queued", execution: null });
      await expect(
        fixture.service.prepareForDispatch(
          submitted.task.taskId,
          "still-closed-epoch",
        ),
      ).rejects.toMatchObject({ code: "invalid_state" });
    } finally {
      if (barrierArmed) {
        await fixture.store
          .probe("releaseDispatchCommitBarrier")
          .catch(() => undefined);
      }
      await fixture.close();
    }
  });

  it("preserves a submit commit that reached storage before shutdown", async () => {
    const fixture = await createDurableAdmissionFixture();
    let barrierArmed = false;
    try {
      await fixture.store.probe("armCommitBarrier");
      barrierArmed = true;
      const submitting = fixture.service.submitTask(actor, {
        operationId: "daemon-shutdown-submit-race",
        agentId: "agent-a",
        instruction: "preserve the admission winner",
      });
      await fixture.store.probe("waitForCommitBarrier");
      const shuttingDown = fixture.service.prepareForDaemonShutdown({
        reconcile: () => Promise.resolve({ kind: "indeterminate" }),
        revokeAndStop: () => Promise.resolve({ kind: "indeterminate" }),
      });
      await fixture.store.probe("releaseCommitBarrier");
      barrierArmed = false;
      const submitted = await submitting;
      await expect(shuttingDown).resolves.toEqual({
        activeExecutions: 0,
        stopConfirmed: 0,
        stopUnknown: 0,
      });
      await expect(
        fixture.service.getTask(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        state: "paused",
        reason: "daemon_restart",
      });
    } finally {
      if (barrierArmed) {
        await fixture.store
          .probe("releaseCommitBarrier")
          .catch(() => undefined);
      }
      await fixture.close();
    }
  });

  it("pauses queued work and records trusted stop without fabricating a terminal", async () => {
    const authentic = new WeakSet<object>();
    const fixture = await createDurableAdmissionFixture(
      {},
      { stopEvidenceVerifier: verifier(authentic) },
    );
    try {
      const active = await fixture.service.submitTask(actor, {
        operationId: "daemon-shutdown-active",
        agentId: "agent-a",
        instruction: "remain recoverable after administrative shutdown",
      });
      await startExecution(fixture, active.task.taskId);
      const queued = await fixture.service.submitTask(actor, {
        operationId: "daemon-shutdown-queued",
        agentId: "agent-revokable",
        instruction: "pause without launch",
      });
      const stopCalls: ExecutionReference[] = [];
      const supervisor: ExecutionSupervisor = {
        start: () => Promise.resolve({ kind: "pending" }),
        reconcile: (reference) =>
          Promise.resolve({
            kind: "running",
            executionUnitId: `unit-${reference.executionId}`,
          }),
        revokeAndStop: (reference) => {
          stopCalls.push(reference);
          const evidence: VerifiedStopEvidence = {
            kind: "verified",
            platform: "linux-cgroup-v2",
            reference,
            executionUnitId: `unit-${reference.executionId}`,
            generationSealedAt: "2026-09-18T00:00:00.000Z",
            unitEmptyObservedAt: "2026-09-18T00:00:01.000Z",
          };
          authentic.add(evidence);
          return Promise.resolve({ kind: "stopped", evidence });
        },
      };

      await expect(
        fixture.service.prepareForDaemonShutdown(supervisor),
      ).resolves.toEqual({
        activeExecutions: 1,
        stopConfirmed: 1,
        stopUnknown: 0,
      });
      expect(stopCalls).toHaveLength(1);
      await expect(
        fixture.service.getTask(actor, { taskId: active.task.taskId }),
      ).resolves.toMatchObject({
        state: "recovering",
        result: null,
        execution: { state: "recovering", quarantined: true },
      });
      await expect(
        fixture.service.getTask(actor, { taskId: queued.task.taskId }),
      ).resolves.toMatchObject({ state: "paused", reason: "daemon_restart" });
    } finally {
      await fixture.close();
    }
  });

  it("keeps the claim quarantined when the Supervisor cannot confirm stop", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const active = await fixture.service.submitTask(actor, {
        operationId: "daemon-shutdown-unknown",
        agentId: "agent-a",
        instruction: "do not infer stop from an unavailable Supervisor",
      });
      await startExecution(fixture, active.task.taskId);
      const stopCalls: ExecutionReference[] = [];
      const supervisor: ExecutionSupervisor = {
        start: () => Promise.resolve({ kind: "pending" }),
        reconcile: () => Promise.resolve({ kind: "indeterminate" }),
        revokeAndStop: (reference) => {
          stopCalls.push(reference);
          return Promise.resolve({ kind: "indeterminate" });
        },
      };

      await expect(
        fixture.service.prepareForDaemonShutdown(supervisor),
      ).resolves.toEqual({
        activeExecutions: 1,
        stopConfirmed: 0,
        stopUnknown: 1,
      });
      expect(stopCalls).toHaveLength(1);
      await expect(
        fixture.service.getTask(actor, { taskId: active.task.taskId }),
      ).resolves.toMatchObject({
        state: "recovering",
        result: null,
        execution: { state: "recovering", quarantined: true },
      });
    } finally {
      await fixture.close();
    }
  });
});
