import { describe, expect, it } from "vitest";

import { RuntimeWorkerObservationSequence } from "../../src/runtime/worker/protocol.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

const actor = { principalId: "principal-a" };
const questions = [
  {
    question: "Continue?",
    header: "Continue",
    options: [
      { label: "Yes", description: "Continue execution" },
      { label: "No", description: "Stop execution" },
    ],
    multiSelect: false,
  },
] as const;

describe("S4 execution time accounting", () => {
  it("pauses only for durable pure waiting and resumes at first answer acceptance while retaining the claim", async () => {
    let monotonicMilliseconds = 0;
    const fixture = await createDurableAdmissionFixture(
      {},
      { monotonicNow: () => monotonicMilliseconds },
    );
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "time-accounting-submit",
        agentId: "agent-a",
        instruction: "Ask one native question",
        executionLimitSeconds: 60,
      });
      const { reference } = await fixture.service.prepareForDispatch(
        submitted.task.taskId,
        "time-accounting-epoch",
      );
      await fixture.service.markExecutionRunning(reference);

      const decoder = new RuntimeWorkerObservationSequence();
      expect(
        decoder.accept(
          reference,
          JSON.stringify({
            kind: "question",
            reference,
            ordinal: 1,
            questionId: "parallel-question",
            toolUseId: "parallel-tool",
            requestId: "parallel-request",
            toolActivity: "active",
            questions,
          }),
        ),
      ).toBeUndefined();

      monotonicMilliseconds = 1_250;
      const identity = {
        questionId: "pure-wait-question",
        toolUseId: "pure-wait-tool",
        requestId: "pure-wait-request",
      };
      await fixture.service.persistRuntimeQuestion(submitted.task.taskId, {
        reference,
        ...identity,
        ordinal: 1,
        toolActivity: "none",
        questions,
      });
      await expect(
        fixture.service.getTask(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        state: "awaiting_input",
        execution: {
          accountingPhase: "pure_wait",
          accumulatedExecutionMs: 1_250,
        },
        toolActivityStatus: "idle",
        toolActivityEvidence: { toolName: "AskUserQuestion" },
      });

      monotonicMilliseconds = 9_000;
      await fixture.service.reply(actor, {
        operationId: "time-accounting-reply",
        taskId: submitted.task.taskId,
        questionId: identity.questionId,
        answer: { "Continue?": "Yes" },
      });
      await expect(
        fixture.service.getTask(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        state: "awaiting_input",
        execution: {
          accountingPhase: "active",
          accumulatedExecutionMs: 1_250,
        },
        question: {
          state: "accepted",
          delivery: "pending",
          inputExpiryClosedAt: "2026-09-12T08:00:00.000Z",
        },
      });

      monotonicMilliseconds = 11_000;
      await expect(
        fixture.service.cancelTask(actor, {
          operationId: "time-accounting-cancel",
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        task: {
          state: "stopping",
          execution: {
            accountingPhase: "stopped",
            accumulatedExecutionMs: 3_250,
            quarantined: false,
          },
        },
      });
    } finally {
      await fixture.close();
    }
  });
});
