import { describe, expect, it } from "vitest";

import { AgentRegistry } from "../../src/bootstrap/registry.js";
import { DurableAgentExecutionService } from "../../src/core/agent-execution-service.js";
import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

const actor = { principalId: "principal-a" };

describe("execution lifecycle recovery", () => {
  it("quarantines an incomplete durable Execution on daemon restart without replay", async () => {
    const fixture = await createDurableAdmissionFixture();
    let reopened: SqliteDurableAdmissionStore | undefined;
    try {
      const task = await fixture.service.submitTask(actor, {
        operationId: "restart-with-prepared-execution",
        agentId: "agent-a",
        instruction: "must not be replayed after restart",
      });
      const prepared = await fixture.prepareExecution(actor, {
        taskId: task.task.taskId,
      });

      await fixture.store.close();
      reopened = await SqliteDurableAdmissionStore.open({
        databasePath: fixture.databasePath,
      });
      const registry = await AgentRegistry.create(
        fixture.registryConfiguration,
        reopened,
      );
      const service = new DurableAgentExecutionService(registry, reopened, {
        cursorSecret: "execution-recovery-cursor-secret",
      });

      await service.initializeAfterRestart();

      await expect(
        service.getTask(actor, { taskId: task.task.taskId }),
      ).resolves.toMatchObject({
        execution: {
          executionId: prepared.executionId,
          state: "recovering",
          candidateAvailable: false,
          quarantined: true,
        },
      });
    } finally {
      await reopened?.close();
      await fixture.close();
    }
  });
});
