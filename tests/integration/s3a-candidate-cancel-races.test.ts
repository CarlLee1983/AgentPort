import { describe, expect, it } from "vitest";

import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

const actor = { principalId: "principal-a" };

async function preparedFixture() {
  const fixture = await createDurableAdmissionFixture();
  const submitted = await fixture.service.submitTask(actor, {
    operationId: `race-${crypto.randomUUID()}`,
    agentId: "agent-a",
    instruction: "first committed stop reason must win",
  });
  await fixture.prepareExecution(actor, { taskId: submitted.task.taskId });
  const reference = await fixture.executionReference(actor, {
    taskId: submitted.task.taskId,
  });
  return { fixture, taskId: submitted.task.taskId, reference };
}

describe("S3-A candidate and cancellation ordering", () => {
  it("keeps completion when the candidate commits before cancellation", async () => {
    const { fixture, taskId, reference } = await preparedFixture();
    try {
      await fixture.store.probe("armCommitBarrier");
      const candidateCommit = fixture.recordObservation(actor, {
        taskId,
        observation: {
          reference,
          kind: "candidate",
          ordinal: 1,
          finalOrdinal: 1,
          outcome: { kind: "completed", summary: "candidate committed first" },
        },
      });
      await fixture.store.probe("waitForCommitBarrier");
      const cancelCommit = fixture.service.cancelTask(actor, {
        operationId: "cancel-after-candidate",
        taskId,
      });
      await fixture.store.probe("releaseCommitBarrier");
      const [candidate, canceled] = await Promise.allSettled([
        candidateCommit,
        cancelCommit,
      ]);
      expect(candidate.status).toBe("fulfilled");
      expect(canceled).toMatchObject({
        status: "rejected",
        reason: {
          code: "operation_conflict",
          task: {
            taskId,
            execution: { state: "stopping", stopReason: "completion" },
          },
        },
      });

      await expect(
        fixture.service.getTask(actor, { taskId }),
      ).resolves.toMatchObject({
        execution: {
          state: "stopping",
          stopReason: "completion",
          candidateAvailable: true,
          quarantined: false,
        },
      });
    } finally {
      await fixture.store.probe("releaseCommitBarrier").catch(() => undefined);
      await fixture.close();
    }
  });

  it("keeps cancellation when cancel commits before a late candidate", async () => {
    const { fixture, taskId, reference } = await preparedFixture();
    try {
      await fixture.store.probe("armCommitBarrier");
      const cancelCommit = fixture.service.cancelTask(actor, {
        operationId: "cancel-before-candidate",
        taskId,
      });
      await fixture.store.probe("waitForCommitBarrier");
      const candidateCommit = fixture.recordObservation(actor, {
        taskId,
        observation: {
          reference,
          kind: "candidate",
          ordinal: 1,
          finalOrdinal: 1,
          outcome: {
            kind: "completed",
            summary: "late bounded candidate evidence",
          },
        },
      });
      await fixture.store.probe("releaseCommitBarrier");
      const [canceled, candidate] = await Promise.all([
        cancelCommit,
        candidateCommit,
      ]);
      expect(canceled).toMatchObject({
        task: { taskId, state: "paused" },
        replayed: false,
      });
      expect(candidate).toMatchObject({
        execution: {
          state: "stopping",
          stopReason: "cancellation",
          candidateAvailable: true,
          quarantined: false,
        },
      });

      const execution = await fixture.store.getExecution({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        taskId,
      });
      expect(execution).toMatchObject({
        state: "stopping",
        stopReason: "cancellation",
        workspaceClaim: "held",
      });
      expect(execution).not.toHaveProperty("result");
    } finally {
      await fixture.store.probe("releaseCommitBarrier").catch(() => undefined);
      await fixture.close();
    }
  });
});
