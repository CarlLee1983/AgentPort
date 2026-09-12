import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AgentRegistry } from "../../src/bootstrap/registry.js";
import { DurableAgentExecutionService } from "../../src/core/agent-execution-service.js";
import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";
import { openStore, submit } from "../fixtures/durable-store.js";

describe("operation receipts", () => {
  it("serializes concurrent submit and stable replays/conflicts", async () => {
    const fixture = await openStore();
    try {
      const request = submit();
      const results = await Promise.all([
        fixture.store.submit(request),
        fixture.store.submit(request),
      ]);
      expect(results.map((r) => r.task.taskId)).toEqual(["task-1", "task-1"]);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      await expect(
        fixture.store.submit(submit({ fingerprint: "changed" })),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      const cancel = {
        accessScopeId: "scope-a",
        principalId: "principal-a",
        operationId: "cancel-1",
        fingerprint: "cancel-fingerprint",
        taskId: "task-1",
        expectedStates: ["queued", "paused"] as const,
        nextState: "canceled" as const,
        eventType: "canceled" as const,
      };
      const canceled = await Promise.all([
        fixture.store.cancel(cancel),
        fixture.store.cancel(cancel),
      ]);
      expect(canceled.filter((r) => !r.replayed)).toHaveLength(1);
      await fixture.store.submit(
        submit({
          operationId: "submit-2",
          taskId: "task-2",
          contextId: "context-2",
          binding: { ...submit().binding, bindingSnapshotId: "binding-2" },
        }),
      );
      await expect(
        fixture.store.cancel({
          ...cancel,
          taskId: "task-2",
          fingerprint: "cancel-task-2-fingerprint",
        }),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      await expect(
        fixture.store.cancel({
          ...cancel,
          operationId: "submit-1",
          fingerprint: "submit-fingerprint",
        }),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      await expect(
        fixture.store.submit(
          submit({
            accessScopeId: "scope-b",
            taskId: "scope-b-task",
            contextId: "scope-b-context",
            binding: {
              ...submit().binding,
              bindingSnapshotId: "scope-b-binding",
            },
          }),
        ),
      ).resolves.toMatchObject({ replayed: false });
    } finally {
      await fixture.dispose();
    }
  });

  it("returns the committed canceled snapshot to every concurrent replay", async () => {
    const fixture = await createDurableAdmissionFixture();
    const actor = { principalId: "principal-a" };
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "concurrent-cancel-submit",
        agentId: "agent-a",
        instruction: "cancel exactly once",
      });
      const input = {
        operationId: "concurrent-cancel",
        taskId: submitted.task.taskId,
      };
      const results = await Promise.all([
        fixture.service.cancelTask(actor, input),
        fixture.service.cancelTask(actor, input),
      ]);
      expect(results.filter(({ replayed }) => !replayed)).toHaveLength(1);
      expect(results).toMatchObject([
        { task: { state: "canceled", revision: 2 } },
        { task: { state: "canceled", revision: 2 } },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("replays an accepted submit after its configured policy becomes stricter", async () => {
    const fixture = await createDurableAdmissionFixture();
    const actor = { principalId: "principal-a" };
    const input = {
      operationId: "policy-change-replay",
      agentId: "agent-a",
      instruction: "retain the original admission receipt",
      executionLimitSeconds: 80,
    };
    try {
      const accepted = await fixture.service.submitTask(actor, input);
      await fixture.registry.replace({
        ...fixture.registryConfiguration,
        agents: fixture.registryConfiguration.agents.map((agent) =>
          agent.agentId === "agent-a"
            ? {
                ...agent,
                policy: {
                  ...agent.policy,
                  maximumExecutionLimitSeconds: 50,
                },
              }
            : agent,
        ),
      });
      await expect(
        fixture.service.submitTask(actor, input),
      ).resolves.toMatchObject({
        replayed: true,
        task: { taskId: accepted.task.taskId, executionLimitSeconds: 80 },
      });
      await expect(
        fixture.service.submitTask(actor, {
          ...input,
          operationId: "new-operation-under-stricter-policy",
        }),
      ).rejects.toMatchObject({ code: "validation_error" });
    } finally {
      await fixture.close();
    }
  });

  it("replays a lost submit response after restart with the current paused snapshot", async () => {
    const fixture = await createDurableAdmissionFixture();
    const actor = { principalId: "principal-a" };
    try {
      const discardedResponse = await fixture.service.submitTask(actor, {
        operationId: "lost-submit-response",
        agentId: "agent-a",
        instruction: "admit exactly once",
      });
      const taskId = discardedResponse.task.taskId;
      await fixture.store.close();

      const reopenedStore = await SqliteDurableAdmissionStore.open({
        databasePath: join(fixture.directory, "agentport.sqlite"),
      });
      try {
        const registry = await AgentRegistry.create(
          fixture.registryConfiguration,
          reopenedStore,
        );
        const restarted = new DurableAgentExecutionService(
          registry,
          reopenedStore,
          {
            cursorSecret: "ap002-fixture-cursor-secret",
          },
        );
        await restarted.initializeAfterRestart();
        const replay = await restarted.submitTask(actor, {
          operationId: "lost-submit-response",
          agentId: "agent-a",
          instruction: "admit exactly once",
        });
        expect(replay).toMatchObject({
          replayed: true,
          task: {
            taskId,
            state: "paused",
            revision: 2,
            observationStatus: "current",
          },
        });
        expect((await restarted.listTasks(actor, {})).tasks).toHaveLength(1);
      } finally {
        await reopenedStore.close();
      }
    } finally {
      await fixture.close();
    }
  });

  it("replays a lost cancel response after restart with the committed snapshot", async () => {
    const fixture = await createDurableAdmissionFixture();
    const actor = { principalId: "principal-a" };
    let reopenedStore: SqliteDurableAdmissionStore | undefined;
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "lost-cancel-submit",
        agentId: "agent-a",
        instruction: "cancel before response loss",
      });
      const cancelInput = {
        operationId: "lost-cancel-response",
        taskId: submitted.task.taskId,
      };
      await fixture.service.cancelTask(actor, cancelInput);
      await fixture.store.close();
      reopenedStore = await SqliteDurableAdmissionStore.open({
        databasePath: join(fixture.directory, "agentport.sqlite"),
      });
      const restarted = new DurableAgentExecutionService(
        await AgentRegistry.create(
          fixture.registryConfiguration,
          reopenedStore,
        ),
        reopenedStore,
        { cursorSecret: "ap002-fixture-cursor-secret" },
      );
      await restarted.initializeAfterRestart();
      await expect(
        restarted.cancelTask(actor, cancelInput),
      ).resolves.toMatchObject({
        replayed: true,
        task: {
          taskId: submitted.task.taskId,
          state: "canceled",
          revision: 2,
        },
      });
    } finally {
      await reopenedStore?.close();
      await fixture.close();
    }
  });
});
