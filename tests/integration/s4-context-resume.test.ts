import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sessionReferenceFor } from "../../src/runtime/claude/session-reference.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

const actor = { principalId: "principal-a" };

describe("S4 Context resumption", () => {
  it("clears only the named durable predecessor blocker and preserves protected native continuity", async () => {
    const fixture = await createDurableAdmissionFixture({
      continuationEncryptionKey: randomBytes(32).toString("base64url"),
    });
    try {
      const workspace = fixture.registry
        .authorize(actor.principalId)
        ?.getAgent("agent-a")?.workspace;
      if (workspace === undefined)
        throw new Error("fixture Agent is unavailable");
      const first = await fixture.service.submitTask(actor, {
        operationId: "resume-first-submit",
        agentId: "agent-a",
        instruction: "establish native continuity",
      });
      const second = await fixture.service.submitTask(actor, {
        operationId: "resume-second-submit",
        agentId: "agent-a",
        contextId: first.task.contextId,
        instruction: "this predecessor will fail",
      });
      const successor = await fixture.service.submitTask(actor, {
        operationId: "resume-successor-submit",
        agentId: "agent-a",
        contextId: first.task.contextId,
        instruction: "remain queued with the same identity",
      });

      const firstExecution = await fixture.store.claimAndPrepare({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        expectedRegistryRevision: 1,
        executionId: "resume-first-execution",
        taskId: first.task.taskId,
        generation: "resume-first-generation",
        daemonEpoch: "resume-first-epoch",
        dispatchIntent: true,
        binding: {
          bindingSnapshotId: "resume-first-binding",
          accessScopeId: "scope-a",
          agentId: "agent-a",
          workspaceIdentity: workspace,
          configurationRevision: "fixture-config-1",
          runtimeDriver: "unreachable-fixture-driver",
          runtimeVersion: "0.0.0",
          launchProfileId: "fixture-profile",
          policy: {
            maximumExecutionLimitSeconds: 3_600,
            maximumInputWaitSeconds: 86_400,
          },
          createdAt: "2026-09-14T00:00:00.000Z",
        },
      });
      const firstReference = {
        executionId: firstExecution.executionId,
        generation: firstExecution.generation,
        daemonEpoch: firstExecution.daemonEpoch,
        launchProfileId: firstExecution.launchProfileId,
        workspaceIdentity: firstExecution.workspaceId,
      };
      const token = "claude-session-01J8D7K2WQ6YB8P4M3N5R7T9VX";
      const sessionReference = sessionReferenceFor(firstReference, token);
      await fixture.store.markExecutionRunning({ reference: firstReference });
      await fixture.recordObservation(actor, {
        taskId: first.task.taskId,
        observation: {
          kind: "candidate",
          reference: firstReference,
          ordinal: 1,
          finalOrdinal: 1,
          outcome: { kind: "completed", summary: "done" },
          sessionReference,
          protectedSessionToken: token,
        },
      });
      await fixture.store.commitTerminal({
        evidence: {
          platform: "linux-cgroup-v2",
          reference: firstReference,
          executionUnitId: "resume-first-unit",
          generationSealedAt: "2026-09-14T00:00:01.000Z",
          unitEmptyObservedAt: "2026-09-14T00:00:02.000Z",
        },
      });

      const failedExecution = await fixture.store.claimAndPrepare({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        expectedRegistryRevision: 1,
        executionId: "resume-failed-execution",
        taskId: second.task.taskId,
        generation: "resume-failed-generation",
        daemonEpoch: "resume-failed-epoch",
        dispatchIntent: true,
        binding: {
          bindingSnapshotId: "resume-failed-binding",
          accessScopeId: "scope-a",
          agentId: "agent-a",
          workspaceIdentity: workspace,
          configurationRevision: "fixture-config-1",
          runtimeDriver: "unreachable-fixture-driver",
          runtimeVersion: "0.0.0",
          launchProfileId: "fixture-profile",
          policy: {
            maximumExecutionLimitSeconds: 3_600,
            maximumInputWaitSeconds: 86_400,
          },
          createdAt: "2026-09-14T00:00:03.000Z",
        },
      });
      const failedReference = {
        executionId: failedExecution.executionId,
        generation: failedExecution.generation,
        daemonEpoch: failedExecution.daemonEpoch,
        launchProfileId: failedExecution.launchProfileId,
        workspaceIdentity: failedExecution.workspaceId,
      };
      await fixture.store.markExecutionRunning({ reference: failedReference });
      await fixture.recordObservation(actor, {
        taskId: second.task.taskId,
        observation: {
          kind: "candidate",
          reference: failedReference,
          ordinal: 1,
          finalOrdinal: 1,
          outcome: { kind: "failed", summary: "partial work remains" },
          sessionReference: null,
        },
      });
      await fixture.store.commitTerminal({
        evidence: {
          platform: "linux-cgroup-v2",
          reference: failedReference,
          executionUnitId: "resume-failed-unit",
          generationSealedAt: "2026-09-14T00:00:04.000Z",
          unitEmptyObservedAt: "2026-09-14T00:00:05.000Z",
        },
      });

      await expect(
        fixture.service.getTask(actor, { taskId: successor.task.taskId }),
      ).resolves.toMatchObject({
        state: "paused",
        predecessorTaskId: second.task.taskId,
        blocker: { predecessorTaskId: second.task.taskId, state: "failed" },
      });
      await expect(
        fixture.store.probe("inspectProtectedSessionTokens"),
      ).resolves.toMatchObject([
        { contextId: first.task.contextId, state: "current" },
      ]);

      const resumed = await fixture.service.resumeContext(actor, {
        operationId: "resume-preserve",
        contextId: first.task.contextId,
        expectedRevision: 5,
        continuationMode: "preserve",
      });
      expect(resumed).toMatchObject({
        replayed: false,
        task: {
          taskId: successor.task.taskId,
          state: "queued",
          predecessorTaskId: second.task.taskId,
          blocker: null,
          continuation: { mode: "preserve", nativeContinuity: "preserved" },
        },
      });
      const resumedExecution = await fixture.service.prepareForDispatch(
        successor.task.taskId,
        "resume-successor-epoch",
      );
      expect(resumedExecution).toMatchObject({
        continuation: {
          kind: "resume",
          sourceReference: firstReference,
          sessionReference,
          protectedSessionToken: token,
        },
      });
      await expect(
        fixture.store.probe("inspectProtectedSessionTokens"),
      ).resolves.toMatchObject([
        { contextId: first.task.contextId, state: "invalidated" },
      ]);
      const lateSuccessor = await fixture.service.submitTask(actor, {
        operationId: "resume-late-successor-submit",
        agentId: "agent-a",
        contextId: first.task.contextId,
        instruction: "remain blocked if the preserve execution fails",
      });
      await fixture.service.markExecutionRunning(resumedExecution.reference);
      await fixture.recordObservation(actor, {
        taskId: successor.task.taskId,
        observation: {
          kind: "candidate",
          reference: resumedExecution.reference,
          ordinal: 1,
          finalOrdinal: 1,
          outcome: { kind: "failed", summary: "continuation failed" },
          sessionReference: null,
        },
      });
      await fixture.store.commitTerminal({
        evidence: {
          platform: "linux-cgroup-v2",
          reference: resumedExecution.reference,
          executionUnitId: "resume-preserve-failed-unit",
          generationSealedAt: "2026-09-14T00:00:06.000Z",
          unitEmptyObservedAt: "2026-09-14T00:00:07.000Z",
        },
      });
      await expect(
        fixture.store.probe("inspectProtectedSessionTokens"),
      ).resolves.toMatchObject([
        { contextId: first.task.contextId, state: "invalidated" },
      ]);
      const blockedLateSuccessor = await fixture.service.getTask(actor, {
        taskId: lateSuccessor.task.taskId,
      });
      await expect(
        fixture.service.resumeContext(actor, {
          operationId: "resume-invalidated-preserve",
          contextId: first.task.contextId,
          expectedRevision: blockedLateSuccessor.contextRevision,
          continuationMode: "preserve",
        }),
      ).rejects.toMatchObject({ code: "invalid_state" });
    } finally {
      await fixture.close();
    }
  });

  it("requires an explicit fresh summary and durably abandons native continuity", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const predecessor = await fixture.service.submitTask(actor, {
        operationId: "fresh-predecessor-submit",
        agentId: "agent-a",
        instruction: "cancel this predecessor",
      });
      const successor = await fixture.service.submitTask(actor, {
        operationId: "fresh-successor-submit",
        agentId: "agent-a",
        contextId: predecessor.task.contextId,
        instruction: "retain this queued task",
      });
      await fixture.service.cancelTask(actor, {
        operationId: "fresh-predecessor-cancel",
        taskId: predecessor.task.taskId,
      });
      const lateFollowUp = await fixture.service.submitTask(actor, {
        operationId: "fresh-late-follow-up-submit",
        agentId: "agent-a",
        contextId: predecessor.task.contextId,
        instruction: "remain paused behind the existing blocker",
      });
      expect(lateFollowUp.task).toMatchObject({
        state: "paused",
        reason: "predecessor_blocked",
        predecessorTaskId: successor.task.taskId,
        blocker: {
          predecessorTaskId: predecessor.task.taskId,
          state: "canceled",
        },
      });

      await expect(
        fixture.service.resumeContext(actor, {
          operationId: "fresh-missing-summary",
          contextId: predecessor.task.contextId,
          expectedRevision: 4,
          continuationMode: "fresh_session",
        }),
      ).rejects.toMatchObject({ code: "validation_error" });

      const resumed = await fixture.service.resumeContext(actor, {
        operationId: "fresh-empty-summary",
        contextId: predecessor.task.contextId,
        expectedRevision: 4,
        continuationMode: "fresh_session",
        contextSummary: "",
      });
      expect(resumed).toMatchObject({
        task: {
          taskId: successor.task.taskId,
          state: "queued",
          blocker: null,
          continuation: {
            mode: "fresh_session",
            nativeContinuity: "abandoned",
          },
        },
      });
      await expect(
        fixture.service.prepareForDispatch(
          successor.task.taskId,
          "fresh-successor-epoch",
        ),
      ).resolves.toMatchObject({
        continuation: { kind: "fresh_session", contextSummary: "" },
      });
    } finally {
      await fixture.close();
    }
  });
});
