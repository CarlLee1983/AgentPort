import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";
import { openStore, submit } from "../fixtures/durable-store.js";

const schema = [
  {
    question: "Which color should be used?",
    header: "Color",
    options: [
      { label: "Blue", description: "Use blue" },
      { label: "Red", description: "Use red" },
    ],
    multiSelect: false,
  },
  {
    question: "Which styles should be enabled?",
    header: "Style",
    options: [
      { label: "Concise", description: "Short" },
      { label: "Detailed", description: "Long" },
    ],
    multiSelect: true,
  },
] as const;

async function runningTask() {
  const fixture = await openStore();
  const accepted = await fixture.store.submit(
    submit({
      operationId: "question-submit",
      fingerprint: "question-submit",
      taskId: "question-task",
      contextId: "question-context",
    }),
  );
  if (accepted.replayed)
    throw new Error("fixture submit unexpectedly replayed");
  const execution = await fixture.store.claimAndPrepare({
    accessScopeId: "scope-a",
    allowedAgentIds: ["agent-a"],
    expectedRegistryRevision: 0,
    executionId: "question-execution",
    taskId: accepted.task.taskId,
    generation: "question-generation",
    daemonEpoch: "question-epoch",
    dispatchIntent: true,
    binding: {
      ...submit().binding,
      bindingSnapshotId: "question-execution-binding",
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
  return { fixture, taskId: accepted.task.taskId, reference };
}

describe("S4 durable Question storage", () => {
  it("persists the trusted Question before read, admits exactly one scoped answer, and resumes only after trusted acknowledgement", async () => {
    const { fixture, taskId, reference } = await runningTask();
    try {
      const observation = {
        reference,
        questionId: "native-question-1",
        toolUseId: "tool-native-1",
        requestId: "request-native-1",
        ordinal: 1,
        toolActivity: "none" as const,
        activeElapsedMs: 0,
        schema,
        expiresAt: "2026-09-15T00:00:00.000Z",
        now: "2026-09-14T00:00:00.000Z",
      };
      await expect(
        fixture.store.getTaskProjection({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId,
        }),
      ).resolves.toMatchObject({ task: { state: "running" }, question: null });

      await expect(
        fixture.store.persistQuestionObservation(observation),
      ).resolves.toMatchObject({
        questionId: "native-question-1",
        state: "pending",
        delivery: "pending",
        answer: null,
      });
      await expect(
        fixture.store.persistQuestionObservation(observation),
      ).resolves.toMatchObject({
        questionId: "native-question-1",
        state: "pending",
      });
      await expect(
        fixture.store.getTaskProjection({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId,
        }),
      ).resolves.toMatchObject({
        task: { state: "awaiting_input" },
        question: { questionId: "native-question-1", state: "pending" },
      });

      const reply = {
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        expectedRegistryRevision: 0,
        operationId: "question-reply-1",
        fingerprint: "question-reply-1",
        principalId: "principal-a",
        taskId,
        questionId: "native-question-1",
        answer: {
          "Which color should be used?": "Blue",
          "Which styles should be enabled?": "Concise, Detailed",
        },
        now: "2026-09-14T00:01:00.000Z",
      };
      await expect(
        fixture.store.replyToQuestion({ ...reply, accessScopeId: "scope-b" }),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(fixture.store.replyToQuestion(reply)).resolves.toMatchObject(
        {
          replayed: false,
          task: { state: "awaiting_input" },
          question: {
            state: "accepted",
            delivery: "pending",
            answer: {
              "Which color should be used?": "Blue",
              "Which styles should be enabled?": "Concise, Detailed",
            },
          },
        },
      );
      await expect(fixture.store.replyToQuestion(reply)).resolves.toMatchObject(
        {
          replayed: true,
          question: { state: "accepted", delivery: "pending" },
        },
      );
      await expect(
        fixture.store.replyToQuestion({
          ...reply,
          operationId: "question-reply-different",
          fingerprint: "question-reply-different",
          answer: {
            "Which color should be used?": "Red",
            "Which styles should be enabled?": "Concise",
          },
        }),
      ).rejects.toMatchObject({ code: "operation_conflict" });

      await expect(
        fixture.store.acknowledgeQuestionDelivery({
          reference: { ...reference, generation: "wrong-generation" },
          questionId: "native-question-1",
          toolUseId: "tool-native-1",
          requestId: "request-native-1",
          now: "2026-09-14T00:02:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      await expect(
        fixture.store.acknowledgeQuestionDelivery({
          reference,
          questionId: "native-question-1",
          toolUseId: "tool-native-1",
          requestId: "request-native-1",
          now: "2026-09-14T00:02:00.000Z",
        }),
      ).resolves.toMatchObject({
        task: { state: "running" },
        question: { state: "closed", delivery: "acknowledged" },
      });
      await expect(
        fixture.store.acknowledgeQuestionDelivery({
          reference,
          questionId: "native-question-1",
          toolUseId: "tool-native-1",
          requestId: "request-native-1",
          now: "2026-09-14T00:03:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "operation_conflict" });
    } finally {
      await fixture.dispose();
    }
  });

  it("preserves the native callback relation across restart and binds acknowledgement to it", async () => {
    const { fixture, taskId, reference } = await runningTask();
    let reopened: SqliteDurableAdmissionStore | undefined;
    try {
      const observation = {
        reference,
        questionId: "native-question-restart",
        toolUseId: "tool-native-restart",
        requestId: "request-native-restart",
        ordinal: 1,
        toolActivity: "none" as const,
        activeElapsedMs: 0,
        schema,
        expiresAt: "2026-09-15T00:00:00.000Z",
        now: "2026-09-14T00:00:00.000Z",
      };
      await expect(
        fixture.store.persistQuestionObservation(observation),
      ).resolves.toMatchObject({
        questionId: observation.questionId,
        toolUseId: observation.toolUseId,
        requestId: observation.requestId,
      });
      await fixture.store.replyToQuestion({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        expectedRegistryRevision: 0,
        operationId: "question-restart-reply",
        fingerprint: "question-restart-reply",
        principalId: "principal-a",
        taskId,
        questionId: observation.questionId,
        answer: {
          "Which color should be used?": "Blue",
          "Which styles should be enabled?": "Concise, Detailed",
        },
        now: "2026-09-14T00:01:00.000Z",
      });

      await fixture.store.close();
      reopened = await SqliteDurableAdmissionStore.open({
        databasePath: join(fixture.directory, "store.sqlite"),
      });
      const delivery = {
        reference,
        questionId: observation.questionId,
        toolUseId: observation.toolUseId,
        requestId: observation.requestId,
        now: "2026-09-14T00:02:00.000Z",
      };
      await expect(
        reopened.getQuestionForDelivery(delivery),
      ).resolves.toMatchObject({
        questionId: observation.questionId,
        toolUseId: observation.toolUseId,
        requestId: observation.requestId,
        state: "accepted",
        delivery: "pending",
      });
      await expect(
        reopened.acknowledgeQuestionDelivery({
          ...delivery,
          toolUseId: "tool-native-other",
          now: "2026-09-14T00:02:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      await expect(
        reopened.acknowledgeQuestionDelivery({
          ...delivery,
          now: "2026-09-14T00:02:00.000Z",
        }),
      ).resolves.toMatchObject({
        task: { state: "running" },
        question: {
          toolUseId: observation.toolUseId,
          requestId: observation.requestId,
          state: "closed",
          delivery: "acknowledged",
        },
      });
    } finally {
      await reopened?.close();
      await fixture.dispose();
    }
  });
});
