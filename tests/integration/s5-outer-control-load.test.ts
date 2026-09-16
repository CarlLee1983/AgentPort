import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AgentRegistry,
  type RegistryConfiguration,
} from "../../src/bootstrap/registry.js";
import { DurableAgentExecutionService } from "../../src/core/agent-execution-service.js";
import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";

const ACTOR = { principalId: "ap015-principal" };
const PER_WORKSPACE_QUEUE_BOUND = 32;
const ACTIVE_EXECUTION_BOUND = 4;
const GLOBAL_QUEUE_BOUND = 256;

describe("AP-015 existing-Task control under synthetic load", () => {
  it("preserves per-Task controls and their durable receipts after general receipt saturation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentport-ap015-"));
    const workspacePaths = await Promise.all(
      ["a", "b", "c", "d", "e"].map(async (name) => {
        const path = join(directory, `workspace-${name}`);
        await mkdir(path);
        return path;
      }),
    );
    const agentIds = workspacePaths.map(
      (_, index) => `agent-${String(index + 1)}`,
    );
    const registryConfiguration: RegistryConfiguration = {
      credentials: { "ap015-token": ACTOR.principalId },
      principals: [
        {
          principalId: ACTOR.principalId,
          accessScopeId: "ap015-scope",
          active: true,
          allowedAgentIds: agentIds,
        },
      ],
      agents: agentIds.map((agentId, index) => ({
        agentId,
        description: `AP-015 synthetic Workspace ${String(index + 1)}`,
        workspacePath: workspacePaths[index] ?? directory,
        configurationRevision: "ap015-fixture-config-1",
        runtimeDriver: "ap015-scripted-driver",
        runtimeVersion: "0.0.0",
        launchProfileId: "ap015-fixture-profile",
        policy: {
          maximumExecutionLimitSeconds: 3_600,
          maximumInputWaitSeconds: 86_400,
        },
      })),
    };
    const store = await SqliteDurableAdmissionStore.open({
      databasePath: join(directory, "agentport.sqlite"),
      activeExecutionCapacity: ACTIVE_EXECUTION_BOUND,
      queuePerWorkspace: PER_WORKSPACE_QUEUE_BOUND,
      // 36 accepted Tasks below consume all general submit receipts. Control
      // receipts come from each accepted Task's independent reserve.
      receiptCapacity: 36,
    });
    try {
      const registry = await AgentRegistry.create(registryConfiguration, store);
      let identifier = 0;
      const { service } =
        DurableAgentExecutionService.createPlatformNeutralPreparationFixture(
          registry,
          store,
          {
            cursorSecret: "ap015-control-load-cursor-secret",
            newId: () => `ap015-id-${String(++identifier)}`,
            now: () => new Date("2026-09-15T00:00:00.000Z"),
          },
        );

      const replyTarget = await service.submitTask(ACTOR, {
        operationId: "ap015-submit-reply-target",
        agentId: "agent-1",
        instruction: "hold scripted reply target",
      });
      const successors = [];
      for (let index = 1; index < PER_WORKSPACE_QUEUE_BOUND; index += 1) {
        successors.push(
          await service.submitTask(ACTOR, {
            operationId: `ap015-submit-fifo-${String(index)}`,
            agentId: "agent-1",
            contextId: replyTarget.task.contextId,
            instruction: `same-Workspace FIFO successor ${String(index)}`,
          }),
        );
      }
      expect(successors).toHaveLength(PER_WORKSPACE_QUEUE_BOUND - 1);
      expect(successors[0]?.task).toMatchObject({
        predecessorTaskId: replyTarget.task.taskId,
        agentId: "agent-1",
      });
      expect(successors.at(-1)?.task.queueOrder).toBeGreaterThan(
        replyTarget.task.queueOrder,
      );
      await expect(
        service.submitTask(ACTOR, {
          operationId: "ap015-submit-over-workspace-bound",
          agentId: "agent-1",
          contextId: replyTarget.task.contextId,
          instruction: "must exceed the documented per-Workspace bound",
        }),
      ).rejects.toMatchObject({ code: "queue_capacity" });

      const cancelTarget = await service.submitTask(ACTOR, {
        operationId: "ap015-submit-cancel-target",
        agentId: "agent-2",
        instruction: "hold scripted cancel target",
      });
      const acknowledgeTarget = await service.submitTask(ACTOR, {
        operationId: "ap015-submit-acknowledge-target",
        agentId: "agent-3",
        instruction: "hold scripted acknowledgement target",
      });
      const heldTarget = await service.submitTask(ACTOR, {
        operationId: "ap015-submit-held-target",
        agentId: "agent-4",
        instruction: "hold synthetic claim without a Runtime start",
      });
      const activeBoundTarget = await service.submitTask(ACTOR, {
        operationId: "ap015-submit-active-bound-target",
        agentId: "agent-5",
        instruction: "prove the configured four-active bound",
      });

      const held = await Promise.all(
        [replyTarget, cancelTarget, acknowledgeTarget, heldTarget].map(
          async ({ task }, index) => {
            const preparation = await service.prepareForDispatch(
              task.taskId,
              `ap015-scripted-reference-${String(index + 1)}`,
            );
            await service.markExecutionRunning(preparation.reference);
            return { task, reference: preparation.reference };
          },
        ),
      );
      const syntheticStartCount = held.length;
      expect(
        new Set(held.map(({ reference }) => reference.workspaceIdentity)).size,
      ).toBe(ACTIVE_EXECUTION_BOUND);
      expect(syntheticStartCount).toBe(ACTIVE_EXECUTION_BOUND);
      await expect(
        service.prepareForDispatch(
          activeBoundTarget.task.taskId,
          "ap015-active-bound-reference",
        ),
      ).rejects.toMatchObject({ code: "queue_capacity" });

      await expect(
        service.submitTask(ACTOR, {
          operationId: "ap015-submit-general-receipt-saturated",
          agentId: "agent-5",
          instruction: "new admission must be distinct from queue capacity",
        }),
      ).rejects.toMatchObject({ code: "tombstone_capacity" });

      const replyReference = held[0]?.reference;
      if (replyReference === undefined)
        throw new Error("reply reference missing");
      await service.persistRuntimeQuestion(replyTarget.task.taskId, {
        reference: replyReference,
        questionId: "ap015-synthetic-question",
        toolUseId: "ap015-synthetic-tool-use",
        requestId: "ap015-synthetic-request",
        ordinal: 1,
        toolActivity: "none",
        questions: [
          {
            question: "Continue the synthetic control load?",
            header: "Control",
            options: [
              { label: "Continue", description: "Continue" },
              { label: "Pause", description: "Pause" },
            ],
            multiSelect: false,
          },
        ],
      });
      const replied = await service.reply(ACTOR, {
        operationId: "ap015-reply",
        taskId: replyTarget.task.taskId,
        questionId: "ap015-synthetic-question",
        answer: { "Continue the synthetic control load?": "Continue" },
      });
      expect(replied).toMatchObject({
        replayed: false,
        task: {
          state: "awaiting_input",
          question: { state: "accepted", delivery: "pending" },
        },
      });
      await expect(
        service.reply(ACTOR, {
          operationId: "ap015-reply",
          taskId: replyTarget.task.taskId,
          questionId: "ap015-synthetic-question",
          answer: { "Continue the synthetic control load?": "Continue" },
        }),
      ).resolves.toMatchObject({ replayed: true });

      const canceled = await service.cancelTask(ACTOR, {
        operationId: "ap015-cancel",
        taskId: cancelTarget.task.taskId,
      });
      expect(canceled).toMatchObject({
        replayed: false,
        task: { state: "stopping", execution: { state: "stopping" } },
      });
      await expect(
        store.getExecution({
          accessScopeId: "ap015-scope",
          allowedAgentIds: agentIds,
          taskId: cancelTarget.task.taskId,
        }),
      ).resolves.toMatchObject({ workspaceClaim: "held" });
      await expect(
        service.cancelTask(ACTOR, {
          operationId: "ap015-cancel",
          taskId: cancelTarget.task.taskId,
        }),
      ).resolves.toMatchObject({ replayed: true, task: { state: "stopping" } });

      const recovered = await store.recoverExecutions();
      expect(recovered).toHaveLength(ACTIVE_EXECUTION_BOUND);
      for (const { task } of held) {
        await expect(
          store.getExecution({
            accessScopeId: "ap015-scope",
            allowedAgentIds: agentIds,
            taskId: task.taskId,
          }),
        ).resolves.toMatchObject({
          state: "recovering",
          workspaceClaim: "quarantined",
        });
      }
      const recoveringAck = await service.getTask(ACTOR, {
        taskId: acknowledgeTarget.task.taskId,
      });
      await expect(
        service.acknowledgeInterruption(ACTOR, {
          operationId: "ap015-acknowledge-premature",
          taskId: acknowledgeTarget.task.taskId,
          expectedRevision: recoveringAck.revision,
        }),
      ).rejects.toMatchObject({ code: "not_found" });

      const acknowledgementReference = held[2]?.reference;
      if (acknowledgementReference === undefined)
        throw new Error("acknowledgement reference missing");
      // Synthetic same-Reference stopped precondition for this store branch;
      // it does not exercise a Runtime or claim production Stop Evidence.
      await store.confirmRecoveryStopped({
        evidence: {
          platform: "linux-cgroup-v2",
          reference: acknowledgementReference,
          executionUnitId: "ap015-scripted-precondition-unit",
          generationSealedAt: "2026-09-15T00:00:01.000Z",
          unitEmptyObservedAt: "2026-09-15T00:00:02.000Z",
        },
        now: "2026-09-15T00:00:03.000Z",
      });
      const acknowledged = await service.acknowledgeInterruption(ACTOR, {
        operationId: "ap015-acknowledge",
        taskId: acknowledgeTarget.task.taskId,
        expectedRevision: recoveringAck.revision,
      });
      expect(acknowledged).toMatchObject({
        replayed: false,
        task: { state: "interrupted", execution: { state: "interrupted" } },
      });
      await expect(
        store.getExecution({
          accessScopeId: "ap015-scope",
          allowedAgentIds: agentIds,
          taskId: acknowledgeTarget.task.taskId,
        }),
      ).resolves.toMatchObject({ workspaceClaim: "released" });
      await expect(
        service.acknowledgeInterruption(ACTOR, {
          operationId: "ap015-acknowledge",
          taskId: acknowledgeTarget.task.taskId,
          expectedRevision: recoveringAck.revision,
        }),
      ).resolves.toMatchObject({
        replayed: true,
        task: { state: "interrupted" },
      });

      for (const task of [
        replyTarget.task,
        cancelTarget.task,
        heldTarget.task,
      ]) {
        await expect(
          service.getTask(ACTOR, { taskId: task.taskId }),
        ).resolves.toMatchObject({ state: "recovering" });
        await expect(
          store.getExecution({
            accessScopeId: "ap015-scope",
            allowedAgentIds: agentIds,
            taskId: task.taskId,
          }),
        ).resolves.toMatchObject({ workspaceClaim: "quarantined" });
      }
      await expect(
        service.getTask(ACTOR, { taskId: acknowledgeTarget.task.taskId }),
      ).resolves.toMatchObject({ state: "interrupted" });
      await expect(store.probe("inspectDurability")).resolves.toMatchObject({
        receipts: 39,
        reservations: 36,
      });
    } finally {
      await store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects the 257th distinct-Workspace admission at the default global queue bound", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentport-ap015-global-"));
    const store = await SqliteDurableAdmissionStore.open({
      databasePath: join(directory, "agentport.sqlite"),
      // Leave queueGlobal and queuePerWorkspace at their documented defaults.
      // This prevents general receipts from masking the 257th queue admission.
      receiptCapacity: GLOBAL_QUEUE_BOUND + 1,
    });
    try {
      const workspaceIdentities = new Set<string>();
      for (let index = 1; index <= GLOBAL_QUEUE_BOUND; index += 1) {
        const workspaceIdentity = `ap015-global-workspace-${String(index)}`;
        workspaceIdentities.add(workspaceIdentity);
        await store.submit({
          accessScopeId: "ap015-global-scope",
          operationId: `ap015-global-submit-${String(index)}`,
          fingerprint: `ap015-global-submit-${String(index)}`,
          principalId: ACTOR.principalId,
          taskId: `ap015-global-task-${String(index)}`,
          contextId: `ap015-global-context-${String(index)}`,
          agentId: `ap015-global-agent-${String(index)}`,
          instruction: "distinct Workspace queue capacity probe",
          binding: {
            bindingSnapshotId: `ap015-global-binding-${String(index)}`,
            configurationRevision: "ap015-global-fixture-config-1",
            workspaceIdentity: {
              canonicalPath: `/ap015-global/workspace-${String(index)}`,
              filesystemIdentity: workspaceIdentity,
            },
            runtimeDriver: "ap015-scripted-driver",
            runtimeVersion: "0.0.0",
            launchProfileId: "ap015-fixture-profile",
            policy: {
              maximumExecutionLimitSeconds: 3_600,
              maximumInputWaitSeconds: 86_400,
            },
          },
        });
      }
      expect(workspaceIdentities.size).toBe(GLOBAL_QUEUE_BOUND);
      await expect(
        store.submit({
          accessScopeId: "ap015-global-scope",
          operationId: "ap015-global-submit-257",
          fingerprint: "ap015-global-submit-257",
          principalId: ACTOR.principalId,
          taskId: "ap015-global-task-257",
          contextId: "ap015-global-context-257",
          agentId: "ap015-global-agent-257",
          instruction:
            "257th distinct Workspace must hit global queue capacity",
          binding: {
            bindingSnapshotId: "ap015-global-binding-257",
            configurationRevision: "ap015-global-fixture-config-1",
            workspaceIdentity: {
              canonicalPath: "/ap015-global/workspace-257",
              filesystemIdentity: "ap015-global-workspace-257",
            },
            runtimeDriver: "ap015-scripted-driver",
            runtimeVersion: "0.0.0",
            launchProfileId: "ap015-fixture-profile",
            policy: {
              maximumExecutionLimitSeconds: 3_600,
              maximumInputWaitSeconds: 86_400,
            },
          },
        }),
      ).rejects.toMatchObject({ code: "queue_capacity" });
    } finally {
      await store.close();
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);
});
