import { describe, expect, it } from "vitest";

import {
  SqliteDurableAdmissionStore,
  type StoredExecution,
} from "../../src/storage/sqlite-durable-admission-store.js";
import { openStore, submit } from "../fixtures/durable-store.js";

async function completeExecution(
  store: SqliteDurableAdmissionStore,
  execution: StoredExecution,
  suffix: string,
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
    now: `2026-09-14T00:00:01.${suffix.padStart(3, "0")}Z`,
    observation: {
      kind: "candidate",
      ordinal: 1,
      finalOrdinal: 1,
      reference,
      outcome: { kind: "completed", summary: `completed-${suffix}` },
      sessionReference: null,
    },
  });
  await store.commitTerminal({
    evidence: {
      platform: "linux-cgroup-v2",
      reference,
      executionUnitId: `unit-${suffix}`,
      generationSealedAt: `2026-09-14T00:00:02.${suffix.padStart(3, "0")}Z`,
      unitEmptyObservedAt: `2026-09-14T00:00:03.${suffix.padStart(3, "0")}Z`,
    },
  });
}

describe("S4 durable Context queue", () => {
  it("backfills legacy null limits within the fixed Context policy", async () => {
    const fixture = await openStore();
    try {
      const binding = {
        ...submit().binding,
        policy: {
          maximumExecutionLimitSeconds: 30,
          maximumInputWaitSeconds: 45,
        },
      };
      await fixture.store.submit(
        submit({
          operationId: "s4-legacy-null-limits",
          fingerprint: "s4-legacy-null-limits",
          taskId: "s4-legacy-null-limits-task",
          contextId: "s4-legacy-null-limits-context",
          binding,
        }),
      );

      await fixture.store.claimAndPrepare({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        expectedRegistryRevision: 0,
        executionId: "s4-legacy-null-limits-execution",
        taskId: "s4-legacy-null-limits-task",
        generation: "s4-legacy-null-limits-generation",
        daemonEpoch: "s4-legacy-null-limits-epoch",
        dispatchIntent: true,
        binding: {
          ...binding,
          bindingSnapshotId: "s4-legacy-null-limits-dispatch-binding",
          accessScopeId: "scope-a",
          agentId: "agent-a",
          createdAt: "2026-09-14T00:00:00.000Z",
        },
      });

      await expect(
        fixture.store.getTaskForDispatch("s4-legacy-null-limits-task"),
      ).resolves.toMatchObject({
        executionLimitSeconds: 30,
        inputWaitSeconds: 45,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("reuses Context binding, records the predecessor, and selects eligible per-Workspace FIFO heads", async () => {
    const fixture = await openStore();
    try {
      const first = await fixture.store.submit(
        submit({
          operationId: "s4-first",
          fingerprint: "s4-first",
          taskId: "s4-first-task",
          contextId: "s4-context-a",
        }),
      );
      if (first.replayed)
        throw new Error("fixture submit unexpectedly replayed");
      const followUp = await fixture.store.submit(
        submit({
          operationId: "s4-follow-up",
          fingerprint: "s4-follow-up",
          taskId: "s4-follow-up-task",
          contextId: "unused-new-context-id",
          existingContextId: "s4-context-a",
          binding: {
            ...submit().binding,
            bindingSnapshotId: "ignored-follow-up-binding",
            workspaceIdentity: {
              canonicalPath: "/untrusted/different-workspace",
              filesystemIdentity: "untrusted-workspace",
            },
          },
        }),
      );
      await fixture.store.submit(
        submit({
          operationId: "s4-same-workspace",
          fingerprint: "s4-same-workspace",
          taskId: "s4-same-workspace-task",
          contextId: "s4-context-b",
          binding: {
            ...submit().binding,
            bindingSnapshotId: "s4-binding-b",
          },
        }),
      );
      await fixture.store.submit(
        submit({
          operationId: "s4-other-workspace",
          fingerprint: "s4-other-workspace",
          taskId: "s4-other-workspace-task",
          contextId: "s4-context-c",
          binding: {
            ...submit().binding,
            bindingSnapshotId: "s4-binding-c",
            workspaceIdentity: {
              canonicalPath: "/fixture/workspace-b",
              filesystemIdentity: "workspace-b",
            },
          },
        }),
      );

      expect(followUp).toMatchObject({
        replayed: false,
        task: {
          contextId: first.task.contextId,
          predecessorTaskId: first.task.taskId,
        },
      });
      await expect(
        fixture.store.probe("inspectDurability"),
      ).resolves.toMatchObject({ bindingSnapshots: 3, contexts: 3 });

      await expect(
        fixture.store.getEligibleTasksForDispatch({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          limit: 10,
        }),
      ).resolves.toMatchObject([
        { taskId: "s4-first-task" },
        { taskId: "s4-other-workspace-task" },
      ]);
      await expect(
        fixture.store.getEligibleTasksForDispatch({
          accessScopeId: "scope-b",
          allowedAgentIds: ["agent-a"],
          limit: 10,
        }),
      ).resolves.toEqual([]);

      await expect(
        fixture.store.claimAndPrepare({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          expectedRegistryRevision: 0,
          executionId: "s4-follow-up-execution",
          taskId: "s4-follow-up-task",
          generation: "s4-generation",
          daemonEpoch: "s4-epoch",
          binding: {
            ...submit().binding,
            bindingSnapshotId: "s4-dispatch-binding",
            agentId: "agent-a",
            accessScopeId: "scope-a",
            createdAt: "2026-09-14T00:00:00.000Z",
          },
        }),
      ).rejects.toMatchObject({
        code: "invalid_state",
        taskId: "s4-follow-up-task",
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("makes a follow-up eligible only after its predecessor terminalizes completed", async () => {
    const fixture = await openStore();
    try {
      const first = await fixture.store.submit(
        submit({
          operationId: "s4-completion-first",
          fingerprint: "s4-completion-first",
          taskId: "s4-completion-first-task",
          contextId: "s4-completion-context",
        }),
      );
      if (first.replayed)
        throw new Error("fixture submit unexpectedly replayed");
      await fixture.store.submit(
        submit({
          operationId: "s4-completion-follow-up",
          fingerprint: "s4-completion-follow-up",
          taskId: "s4-completion-follow-up-task",
          contextId: "unused-new-context-id",
          existingContextId: "s4-completion-context",
        }),
      );
      const execution = await fixture.store.claimAndPrepare({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        expectedRegistryRevision: 0,
        executionId: "s4-completion-execution",
        taskId: first.task.taskId,
        generation: "s4-completion-generation",
        daemonEpoch: "s4-completion-epoch",
        dispatchIntent: true,
        binding: {
          ...submit().binding,
          bindingSnapshotId: "s4-completion-binding",
          accessScopeId: "scope-a",
          agentId: "agent-a",
          createdAt: "2026-09-14T00:00:00.000Z",
        },
      });
      const reference = {
        executionId: execution.executionId,
        generation: execution.generation,
        daemonEpoch: execution.daemonEpoch,
        launchProfileId: execution.launchProfileId,
        workspaceIdentity: execution.workspaceId,
      };
      await fixture.store.markExecutionRunning({ reference });
      await fixture.store.commitRuntimeObservation({
        taskId: first.task.taskId,
        now: "2026-09-14T00:00:01.000Z",
        observation: {
          kind: "candidate",
          ordinal: 1,
          finalOrdinal: 1,
          reference,
          outcome: { kind: "completed", summary: "finished" },
          sessionReference: null,
        },
      });
      await fixture.store.commitTerminal({
        evidence: {
          platform: "linux-cgroup-v2",
          reference,
          executionUnitId: "s4-completion-unit",
          generationSealedAt: "2026-09-14T00:00:02.000Z",
          unitEmptyObservedAt: "2026-09-14T00:00:03.000Z",
        },
      });

      await expect(
        fixture.store.getEligibleTasksForDispatch({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          limit: 10,
        }),
      ).resolves.toMatchObject([{ taskId: "s4-completion-follow-up-task" }]);
    } finally {
      await fixture.dispose();
    }
  });

  it("claims eligible heads from distinct Workspaces without cross-Workspace serialization", async () => {
    const fixture = await openStore();
    try {
      const first = await fixture.store.submit(
        submit({
          operationId: "s4-concurrent-workspace-a",
          fingerprint: "s4-concurrent-workspace-a",
          taskId: "s4-concurrent-task-a",
          contextId: "s4-concurrent-context-a",
        }),
      );
      const second = await fixture.store.submit(
        submit({
          operationId: "s4-concurrent-workspace-b",
          fingerprint: "s4-concurrent-workspace-b",
          taskId: "s4-concurrent-task-b",
          contextId: "s4-concurrent-context-b",
          binding: {
            ...submit().binding,
            bindingSnapshotId: "s4-concurrent-binding-b",
            workspaceIdentity: {
              canonicalPath: "/fixture/workspace-b",
              filesystemIdentity: "workspace-b",
            },
          },
        }),
      );

      const [executionA, executionB] = await Promise.all([
        fixture.store.claimAndPrepare({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          expectedRegistryRevision: 0,
          executionId: "s4-concurrent-execution-a",
          taskId: first.task.taskId,
          generation: "s4-concurrent-generation-a",
          daemonEpoch: "s4-concurrent-epoch",
          dispatchIntent: true,
          binding: {
            ...submit().binding,
            bindingSnapshotId: "s4-concurrent-dispatch-binding-a",
            accessScopeId: "scope-a",
            agentId: "agent-a",
            createdAt: "2026-09-14T00:00:00.000Z",
          },
        }),
        fixture.store.claimAndPrepare({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          expectedRegistryRevision: 0,
          executionId: "s4-concurrent-execution-b",
          taskId: second.task.taskId,
          generation: "s4-concurrent-generation-b",
          daemonEpoch: "s4-concurrent-epoch",
          dispatchIntent: true,
          binding: {
            ...submit().binding,
            bindingSnapshotId: "s4-concurrent-dispatch-binding-b",
            accessScopeId: "scope-a",
            agentId: "agent-a",
            workspaceIdentity: {
              canonicalPath: "/fixture/workspace-b",
              filesystemIdentity: "workspace-b",
            },
            createdAt: "2026-09-14T00:00:00.000Z",
          },
        }),
      ]);

      expect(executionA).toMatchObject({
        taskId: first.task.taskId,
        workspaceClaim: "held",
      });
      expect(executionB).toMatchObject({
        taskId: second.task.taskId,
        workspaceClaim: "held",
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("preserves Workspace FIFO across Access Scopes without disclosing a foreign head", async () => {
    const fixture = await openStore();
    try {
      const first = await fixture.store.submit(
        submit({
          operationId: "s4-cross-scope-first",
          fingerprint: "s4-cross-scope-first",
          taskId: "s4-cross-scope-first-task",
          contextId: "s4-cross-scope-first-context",
        }),
      );
      const second = await fixture.store.submit(
        submit({
          accessScopeId: "scope-b",
          principalId: "principal-b",
          operationId: "s4-cross-scope-second",
          fingerprint: "s4-cross-scope-second",
          taskId: "s4-cross-scope-second-task",
          contextId: "s4-cross-scope-second-context",
          binding: {
            ...submit().binding,
            bindingSnapshotId: "s4-cross-scope-second-binding",
          },
        }),
      );
      if (first.replayed || second.replayed) {
        throw new Error("fixture submit unexpectedly replayed");
      }
      expect(first.task.queueOrder).toBe(1);
      expect(second.task.queueOrder).toBe(1);

      await expect(
        fixture.store.getEligibleTasksForDispatch({
          accessScopeId: "scope-b",
          allowedAgentIds: ["agent-a"],
          limit: 10,
        }),
      ).resolves.toEqual([]);
      await expect(
        fixture.store.claimAndPrepare({
          accessScopeId: "scope-b",
          allowedAgentIds: ["agent-a"],
          expectedRegistryRevision: 0,
          executionId: "s4-cross-scope-second-execution",
          taskId: second.task.taskId,
          generation: "s4-cross-scope-second-generation",
          daemonEpoch: "s4-cross-scope-epoch",
          dispatchIntent: true,
          binding: {
            ...submit().binding,
            bindingSnapshotId: "s4-cross-scope-second-dispatch-binding",
            accessScopeId: "scope-b",
            agentId: "agent-a",
            createdAt: "2026-09-14T00:00:00.000Z",
          },
        }),
      ).rejects.toMatchObject({ code: "invalid_state" });

      const firstExecution = await fixture.store.claimAndPrepare({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        expectedRegistryRevision: 0,
        executionId: "s4-cross-scope-first-execution",
        taskId: first.task.taskId,
        generation: "s4-cross-scope-first-generation",
        daemonEpoch: "s4-cross-scope-epoch",
        dispatchIntent: true,
        binding: {
          ...submit().binding,
          bindingSnapshotId: "s4-cross-scope-first-dispatch-binding",
          accessScopeId: "scope-a",
          agentId: "agent-a",
          createdAt: "2026-09-14T00:00:00.000Z",
        },
      });
      await completeExecution(fixture.store, firstExecution, "101");

      await expect(
        fixture.store.getEligibleTasksForDispatch({
          accessScopeId: "scope-b",
          allowedAgentIds: ["agent-a"],
          limit: 10,
        }),
      ).resolves.toMatchObject([{ taskId: second.task.taskId }]);
    } finally {
      await fixture.dispose();
    }
  });

  it("limits unreleased active Executions globally and admits the next head after release", async () => {
    const fixture = await openStore();
    try {
      const tasks = await Promise.all(
        Array.from({ length: 5 }, async (_, index) => {
          const suffix = String(index + 1);
          const result = await fixture.store.submit(
            submit({
              operationId: `s4-active-cap-${suffix}`,
              fingerprint: `s4-active-cap-${suffix}`,
              taskId: `s4-active-cap-task-${suffix}`,
              contextId: `s4-active-cap-context-${suffix}`,
              binding: {
                ...submit().binding,
                bindingSnapshotId: `s4-active-cap-binding-${suffix}`,
                workspaceIdentity: {
                  canonicalPath: `/fixture/active-cap-${suffix}`,
                  filesystemIdentity: `active-cap-workspace-${suffix}`,
                },
              },
            }),
          );
          if (result.replayed) {
            throw new Error("fixture submit unexpectedly replayed");
          }
          return result.task;
        }),
      );
      const executions: StoredExecution[] = [];
      for (const [index, task] of tasks.slice(0, 4).entries()) {
        const suffix = String(index + 1);
        executions.push(
          await fixture.store.claimAndPrepare({
            accessScopeId: "scope-a",
            allowedAgentIds: ["agent-a"],
            expectedRegistryRevision: 0,
            executionId: `s4-active-cap-execution-${suffix}`,
            taskId: task.taskId,
            generation: `s4-active-cap-generation-${suffix}`,
            daemonEpoch: "s4-active-cap-epoch",
            dispatchIntent: true,
            binding: {
              ...submit().binding,
              bindingSnapshotId: `s4-active-cap-dispatch-binding-${suffix}`,
              accessScopeId: "scope-a",
              agentId: "agent-a",
              workspaceIdentity: {
                canonicalPath: `/fixture/active-cap-${suffix}`,
                filesystemIdentity: `active-cap-workspace-${suffix}`,
              },
              createdAt: "2026-09-14T00:00:00.000Z",
            },
          }),
        );
      }

      const fifth = tasks[4];
      if (fifth === undefined) throw new Error("missing fifth Task fixture");
      await expect(
        fixture.store.getEligibleTasksForDispatch({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          limit: 10,
        }),
      ).resolves.toEqual([]);
      const fifthClaim = {
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        expectedRegistryRevision: 0,
        executionId: "s4-active-cap-execution-5",
        taskId: fifth.taskId,
        generation: "s4-active-cap-generation-5",
        daemonEpoch: "s4-active-cap-epoch",
        dispatchIntent: true,
        binding: {
          ...submit().binding,
          bindingSnapshotId: "s4-active-cap-dispatch-binding-5",
          accessScopeId: "scope-a",
          agentId: "agent-a",
          workspaceIdentity: {
            canonicalPath: "/fixture/active-cap-5",
            filesystemIdentity: "active-cap-workspace-5",
          },
          createdAt: "2026-09-14T00:00:00.000Z",
        },
      } as const;
      await expect(
        fixture.store.claimAndPrepare(fifthClaim),
      ).rejects.toMatchObject({ code: "queue_capacity" });

      const firstExecution = executions[0];
      if (firstExecution === undefined) {
        throw new Error("missing first Execution fixture");
      }
      await completeExecution(fixture.store, firstExecution, "201");
      await expect(
        fixture.store.getEligibleTasksForDispatch({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          limit: 10,
        }),
      ).resolves.toMatchObject([{ taskId: fifth.taskId }]);
      await expect(
        fixture.store.claimAndPrepare(fifthClaim),
      ).resolves.toMatchObject({
        taskId: fifth.taskId,
        workspaceClaim: "held",
      });
    } finally {
      await fixture.dispose();
    }
  });
});
