import { describe, expect, it } from "vitest";

import type { StoredExecution } from "../../src/storage/sqlite-durable-admission-store.js";
import { openStore, submit } from "../fixtures/durable-store.js";

const FIXTURE_WORKSPACES = [
  "ap014-workspace-a",
  "ap014-workspace-b",
  "ap014-workspace-c",
  "ap014-workspace-d",
] as const;
const DEFAULT_WORKSPACE_QUEUE_BOUND = 32;

function dispatchRequest(taskId: string, workspaceId: string, suffix: string) {
  return {
    accessScopeId: "scope-a",
    allowedAgentIds: ["agent-a"],
    expectedRegistryRevision: 0,
    executionId: `ap014-synthetic-execution-${suffix}`,
    taskId,
    generation: `ap014-synthetic-generation-${suffix}`,
    daemonEpoch: "ap014-synthetic-epoch",
    dispatchIntent: true,
    binding: {
      ...submit().binding,
      bindingSnapshotId: `ap014-synthetic-dispatch-binding-${suffix}`,
      accessScopeId: "scope-a",
      agentId: "agent-a",
      workspaceIdentity: {
        canonicalPath: `/fixture/${workspaceId}`,
        filesystemIdentity: workspaceId,
      },
      createdAt: "2026-09-15T00:00:00.000Z",
    },
  };
}

function referenceFor(execution: StoredExecution) {
  return {
    executionId: execution.executionId,
    generation: execution.generation,
    daemonEpoch: execution.daemonEpoch,
    launchProfileId: execution.launchProfileId,
    workspaceIdentity: execution.workspaceId,
  };
}

describe("S5 outer observation synthetic load fixture", () => {
  it("holds four scripted References, leaves a FIFO Workspace successor queued, and bounds that queue", async () => {
    // This is a SQLite-only contention fixture. Its scripted transitions model
    // synthetic starts; they do not invoke a Runtime or create Stop Evidence.
    const fixture = await openStore();
    try {
      const activeTasks = await Promise.all(
        FIXTURE_WORKSPACES.map(async (workspaceId, index) => {
          const suffix = String(index + 1);
          const accepted = await fixture.store.submit(
            submit({
              operationId: `ap014-active-submit-${suffix}`,
              fingerprint: `ap014-active-fingerprint-${suffix}`,
              taskId: `ap014-active-task-${suffix}`,
              contextId: `ap014-active-context-${suffix}`,
              binding: {
                ...submit().binding,
                bindingSnapshotId: `ap014-active-binding-${suffix}`,
                workspaceIdentity: {
                  canonicalPath: `/fixture/${workspaceId}`,
                  filesystemIdentity: workspaceId,
                },
              },
            }),
          );
          if (accepted.replayed) {
            throw new Error("fixture submit unexpectedly replayed");
          }
          return accepted.task;
        }),
      );
      const first = activeTasks[0];
      if (first === undefined) throw new Error("missing first active Task");

      const workspaceId = FIXTURE_WORKSPACES[0];
      const successors = [];
      for (let index = 1; index < DEFAULT_WORKSPACE_QUEUE_BOUND; index += 1) {
        const suffix = String(index);
        const accepted = await fixture.store.submit(
          submit({
            operationId: `ap014-workspace-successor-submit-${suffix}`,
            fingerprint: `ap014-workspace-successor-fingerprint-${suffix}`,
            taskId: `ap014-workspace-successor-task-${suffix}`,
            contextId: `ap014-workspace-successor-context-${suffix}`,
            binding: {
              ...submit().binding,
              bindingSnapshotId: `ap014-workspace-successor-binding-${suffix}`,
              workspaceIdentity: {
                canonicalPath: `/fixture/${workspaceId}`,
                filesystemIdentity: workspaceId,
              },
            },
          }),
        );
        if (accepted.replayed) {
          throw new Error("fixture successor submit unexpectedly replayed");
        }
        successors.push(accepted.task);
      }

      await expect(
        fixture.store.getEligibleTasksForDispatch({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          limit: 10,
        }),
      ).resolves.toMatchObject(
        activeTasks.map((task) => ({ taskId: task.taskId })),
      );
      expect(successors).toHaveLength(DEFAULT_WORKSPACE_QUEUE_BOUND - 1);
      const firstSuccessor = successors[0];
      if (firstSuccessor === undefined) {
        throw new Error("missing first Workspace successor");
      }
      expect(firstSuccessor.queueOrder).toBeGreaterThan(first.queueOrder);
      expect(
        successors.every(
          (successor, index) =>
            successor.predecessorTaskId === null &&
            successor.queueOrder === firstSuccessor.queueOrder + index,
        ),
      ).toBe(true);

      const heldExecutions = await Promise.all(
        activeTasks.map((task, index) => {
          const workspaceId = FIXTURE_WORKSPACES[index];
          if (workspaceId === undefined) {
            throw new Error("missing scripted Workspace");
          }
          return fixture.store.claimAndPrepare(
            dispatchRequest(task.taskId, workspaceId, String(index + 1)),
          );
        }),
      );
      expect(heldExecutions).toHaveLength(4);
      expect(
        new Set(heldExecutions.map((execution) => execution.workspaceId)),
      ).toEqual(new Set(FIXTURE_WORKSPACES));
      expect(
        heldExecutions.every(
          (execution) =>
            execution.state === "starting" &&
            execution.workspaceClaim === "held",
        ),
      ).toBe(true);

      // The held primary plus 31 queued successors occupy the documented
      // default per-Workspace bound of 32. A 33rd admission is rejected.
      await expect(
        fixture.store.submit(
          submit({
            operationId: "ap014-workspace-33rd-submit",
            fingerprint: "ap014-workspace-33rd-fingerprint",
            taskId: "ap014-workspace-33rd-task",
            contextId: "ap014-workspace-33rd-context",
            binding: {
              ...submit().binding,
              bindingSnapshotId: "ap014-workspace-33rd-binding",
              workspaceIdentity: {
                canonicalPath: `/fixture/${workspaceId}`,
                filesystemIdentity: workspaceId,
              },
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "queue_capacity" });

      let syntheticStartCount = 0;
      for (const execution of heldExecutions) {
        await fixture.store.markExecutionRunning({
          reference: referenceFor(execution),
        });
        syntheticStartCount += 1;
      }

      expect(syntheticStartCount).toBe(4);
      const activeSnapshots = await Promise.all(
        activeTasks.map((task) =>
          fixture.store.getTask({
            accessScopeId: "scope-a",
            allowedAgentIds: ["agent-a"],
            taskId: task.taskId,
          }),
        ),
      );
      expect(activeSnapshots.every((task) => task?.state === "running")).toBe(
        true,
      );
      const successorSnapshots = await Promise.all(
        successors.map((successor) =>
          fixture.store.getTask({
            accessScopeId: "scope-a",
            allowedAgentIds: ["agent-a"],
            taskId: successor.taskId,
          }),
        ),
      );
      expect(
        successorSnapshots.every(
          (successor, index) =>
            successor?.state === "queued" &&
            successor.queueOrder === firstSuccessor.queueOrder + index,
        ),
      ).toBe(true);
      expect(
        heldExecutions.every((execution) => execution.stopReason === null),
      ).toBe(true);
      await expect(
        fixture.store.getEligibleTasksForDispatch({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          limit: 10,
        }),
      ).resolves.toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });
});
