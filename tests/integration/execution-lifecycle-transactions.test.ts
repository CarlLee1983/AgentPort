import { describe, expect, it } from "vitest";

import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

const actor = { principalId: "principal-a" };

describe("execution lifecycle transactions", () => {
  it("persists the administrator-selected launch profile in the Execution Reference", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "execution-managed-launch-profile",
        agentId: "agent-a",
        instruction: "must use the managed launcher profile",
      });

      await fixture.prepareExecution(actor, { taskId: submitted.task.taskId });

      await expect(
        fixture.executionReference(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({ launchProfileId: "fixture-profile" });
    } finally {
      await fixture.close();
    }
  });

  it("atomically claims a Workspace for one prepared Execution", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const first = await fixture.service.submitTask(actor, {
        operationId: "execution-claim-first",
        agentId: "agent-a",
        instruction: "first queued Task",
      });
      const second = await fixture.service.submitTask(actor, {
        operationId: "execution-claim-second",
        agentId: "agent-a",
        instruction: "second queued Task",
      });

      const attempts = await Promise.allSettled([
        fixture.prepareExecution(actor, { taskId: first.task.taskId }),
        fixture.prepareExecution(actor, { taskId: second.task.taskId }),
      ]);

      expect(
        attempts.filter(({ status }) => status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        attempts.find(({ status }) => status === "rejected"),
      ).toMatchObject({
        status: "rejected",
        reason: { code: "invalid_state" },
      });
      expect(
        attempts.find(({ status }) => status === "fulfilled"),
      ).toMatchObject({
        value: { state: "prepared" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("orders concurrent cancellation and claim without a partial terminal state", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const task = await fixture.service.submitTask(actor, {
        operationId: "execution-cancel-race",
        agentId: "agent-a",
        instruction: "one transaction must decide this Task",
      });

      const [prepared, canceled] = await Promise.allSettled([
        fixture.prepareExecution(actor, { taskId: task.task.taskId }),
        fixture.service.cancelTask(actor, {
          operationId: "cancel-racing-execution",
          taskId: task.task.taskId,
        }),
      ]);

      const current = await fixture.service.getTask(actor, {
        taskId: task.task.taskId,
      });
      if (prepared.status === "fulfilled") {
        expect(canceled).toMatchObject({ status: "fulfilled" });
        expect(current).toMatchObject({
          state: "paused",
          reason: "execution_stopping",
          execution: {
            state: "stopping",
            stopReason: "cancellation",
            quarantined: false,
          },
        });
      } else {
        expect(canceled).toMatchObject({ status: "fulfilled" });
        expect(current).toMatchObject({ state: "canceled" });
      }
    } finally {
      await fixture.close();
    }
  });
});
