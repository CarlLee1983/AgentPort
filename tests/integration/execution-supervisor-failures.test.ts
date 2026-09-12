import { describe, expect, it } from "vitest";

import {
  createExecutionSupervisor,
  type ExecutionSupervisorAdapter,
} from "../../src/core/execution-supervisor.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

const actor = { principalId: "principal-a" };

describe("execution supervisor failures", () => {
  it("retains the prepared claim when scripted stop evidence is indeterminate", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const task = await fixture.service.submitTask(actor, {
        operationId: "indeterminate-stop-claim",
        agentId: "agent-a",
        instruction: "a fixture must not release this claim",
      });
      await fixture.prepareExecution(actor, {
        taskId: task.task.taskId,
      });
      const reference = await fixture.executionReference(actor, {
        taskId: task.task.taskId,
      });
      const adapter: ExecutionSupervisorAdapter = {
        start: () => Promise.resolve({ unitId: "fixture-unit" }),
        revokeAndStop: () =>
          Promise.resolve({
            kind: "stopped",
            evidence: { kind: "verified", reference, unitId: "fixture-unit" },
          }),
        reconcile: () => Promise.resolve({ kind: "absent" }),
      };

      await expect(
        createExecutionSupervisor(adapter).revokeAndStop(reference),
      ).resolves.toEqual({ kind: "indeterminate" });
      await expect(
        fixture.recordIndeterminateSupervisorResult(actor, {
          taskId: task.task.taskId,
          reference: { ...reference, generation: "stale-generation" },
        }),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      await fixture.recordIndeterminateSupervisorResult(actor, {
        taskId: task.task.taskId,
        reference,
      });
      await expect(
        fixture.service.getExecutionLifecycle(actor, {
          taskId: task.task.taskId,
        }),
      ).resolves.toMatchObject({
        state: "recovering",
        candidateOutcome: null,
        quarantined: true,
      });
    } finally {
      await fixture.close();
    }
  });
});
