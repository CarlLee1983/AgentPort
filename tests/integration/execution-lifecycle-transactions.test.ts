import { describe, expect, it } from "vitest";

import { reopenWithAp002Store } from "../fixtures/ap002-store.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

const actor = { principalId: "principal-a" };

describe("execution lifecycle transactions", () => {
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
        reason: { code: "operation_conflict" },
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

      expect(
        [prepared, canceled].filter(({ status }) => status === "fulfilled"),
      ).toHaveLength(1);
      const current = await fixture.service.getTask(actor, {
        taskId: task.task.taskId,
      });
      if (prepared.status === "fulfilled") {
        expect(canceled).toMatchObject({
          status: "rejected",
          reason: { code: "operation_conflict" },
        });
        expect(current).toMatchObject({
          state: "paused",
          reason: "execution_prepared",
        });
      } else {
        expect(canceled).toMatchObject({ status: "fulfilled" });
        expect(current).toMatchObject({ state: "canceled" });
      }
    } finally {
      await fixture.close();
    }
  });

  it("preserves execution records while an AP-002 binary reopens schema version 1", async () => {
    const claimedFixture = await createDurableAdmissionFixture();
    try {
      const task = await claimedFixture.service.submitTask(actor, {
        operationId: "rollback-retained-claim",
        agentId: "agent-a",
        instruction: "do not delete this retained claim",
      });
      await claimedFixture.prepareExecution(actor, {
        taskId: task.task.taskId,
      });

      await expect(
        claimedFixture.store.probe("applyExecutionControlRollback"),
      ).resolves.toBeUndefined();
      await expect(
        claimedFixture.store.probe("inspectSchemaVersions"),
      ).resolves.toEqual([1]);
      await claimedFixture.store.close();

      const reopened = reopenWithAp002Store({
        databasePath: claimedFixture.databasePath,
        taskId: task.task.taskId,
      });
      expect(reopened.schemaVersions).toEqual([1]);
      expect(reopened.task).toEqual({
        instruction: "do not delete this retained claim",
      });
      expect(reopened.retainedExecutionClaim).toEqual({
        taskId: task.task.taskId,
        status: "held",
      });
    } finally {
      await claimedFixture.close();
    }
  });
});
