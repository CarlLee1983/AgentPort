import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RuntimeWorkerIngress } from "../../src/runtime/worker/ingress.js";
import {
  RuntimeInputTimeoutError,
  RuntimeWorkerIngressClient,
} from "../../src/runtime/worker/ingress-client.js";
import { encodeWorkerObservation } from "../../src/runtime/worker/protocol.js";
import {
  createDurableAdmissionFixture,
  type DurableAdmissionFixture,
} from "../fixtures/durable-admission.js";

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
] as const;

async function startQuestion(
  fixture: DurableAdmissionFixture,
  suffix: string,
  inputWaitSeconds = 86_400,
  agentId = "agent-a",
) {
  const submitted = await fixture.service.submitTask(
    { principalId: "principal-a" },
    {
      operationId: `${suffix}-submit`,
      agentId,
      instruction: "Ask for a clarification",
      inputWaitSeconds,
    },
  );
  const { reference } = await fixture.service.prepareForDispatch(
    submitted.task.taskId,
    `${suffix}-epoch`,
  );
  await fixture.service.markExecutionRunning(reference);
  const identity = {
    questionId: `${suffix}-question`,
    toolUseId: `${suffix}-tool-use`,
    requestId: `${suffix}-request`,
  };
  await fixture.service.persistRuntimeQuestion(submitted.task.taskId, {
    reference,
    ...identity,
    ordinal: 1,
    toolActivity: "none",
    questions: schema,
  });
  return { taskId: submitted.task.taskId, reference, identity };
}

describe("S4 native Question delivery", () => {
  it("rejects unbound and oversized native Questions without changing the Task", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const submitted = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "invalid-native-question-submit",
          agentId: "agent-a",
          instruction: "Reject invalid native Questions",
        },
      );
      const { reference } = await fixture.service.prepareForDispatch(
        submitted.task.taskId,
        "invalid-native-question-epoch",
      );
      await fixture.service.markExecutionRunning(reference);
      const question = {
        reference,
        questionId: "invalid-native-question",
        toolUseId: "invalid-native-tool-use",
        requestId: "invalid-native-request",
        ordinal: 1,
        toolActivity: "none" as const,
        questions: schema,
      };

      await expect(
        fixture.service.persistRuntimeQuestion(submitted.task.taskId, {
          ...question,
          reference: { ...reference, generation: "foreign-generation" },
        }),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      await expect(
        fixture.service.persistRuntimeQuestion(submitted.task.taskId, {
          ...question,
          questions: [
            {
              ...schema[0],
              question: "x".repeat(4 * 1024 + 1),
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      await expect(
        fixture.service.getTask(
          { principalId: "principal-a" },
          { taskId: submitted.task.taskId },
        ),
      ).resolves.toMatchObject({ state: "running", question: null });
    } finally {
      await fixture.close();
    }
  });

  it("persists before publication, delivers one accepted answer, and resumes only after the worker acknowledgement", async () => {
    const fixture = await createDurableAdmissionFixture();
    const directory = await mkdtemp(
      join(tmpdir(), "agentport-question-ingress-"),
    );
    let ingress: RuntimeWorkerIngress | undefined;
    let worker: RuntimeWorkerIngressClient | undefined;
    try {
      const submitted = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "native-question-submit",
          agentId: "agent-a",
          instruction: "Ask for a clarification",
        },
      );
      const { reference } = await fixture.service.prepareForDispatch(
        submitted.task.taskId,
        "native-question-epoch",
      );
      await fixture.service.markExecutionRunning(reference);
      ingress = await RuntimeWorkerIngress.open({
        endpoint: join(directory, "worker.sock"),
        reference,
        lifecycle: {
          persistQuestion: (question) =>
            fixture.service.persistRuntimeQuestion(
              submitted.task.taskId,
              question,
            ),
          waitForAcceptedAnswer: (value, identity, signal) =>
            fixture.service.waitForAcceptedQuestionAnswer(
              value,
              identity,
              signal,
            ),
          acknowledgeQuestionDelivery: (value, identity) =>
            fixture.service.acknowledgeRuntimeQuestionDelivery(value, identity),
          markQuestionDeliveryUnknown: (value, identity) =>
            fixture.service.markRuntimeQuestionDeliveryUnknown(value, identity),
          recordObservation: (observation) =>
            fixture.service
              .recordRuntimeObservation(submitted.task.taskId, observation)
              .then(() => undefined),
          stopAfterCandidate: () => Promise.resolve(),
          quarantine: () => Promise.resolve(),
        },
      });
      worker = await RuntimeWorkerIngressClient.connect(ingress.session);

      await worker.emit(
        encodeWorkerObservation({
          kind: "question",
          reference,
          ordinal: 1,
          questionId: "native-question-1",
          toolUseId: "tool-native-1",
          requestId: "request-native-1",
          toolActivity: "none",
          questions: schema,
        }),
        1,
        "question",
      );

      await expect(
        fixture.service.getTask(
          { principalId: "principal-a" },
          { taskId: submitted.task.taskId },
        ),
      ).resolves.toMatchObject({
        state: "awaiting_input",
        question: {
          questionId: "native-question-1",
          state: "pending",
          delivery: "pending",
        },
      });

      const nativeIdentity = {
        questionId: "native-question-1",
        toolUseId: "tool-native-1",
        requestId: "request-native-1",
      };
      const delivery = worker.waitForQuestionAnswer(nativeIdentity);
      const reply = {
        operationId: "native-question-reply",
        taskId: submitted.task.taskId,
        questionId: "native-question-1",
        answer: { "Which color should be used?": "Blue" },
      };
      await expect(
        fixture.service.reply({ principalId: "principal-a" }, reply),
      ).resolves.toMatchObject({
        replayed: false,
        task: {
          state: "awaiting_input",
          question: { state: "accepted", delivery: "pending" },
        },
      });
      await expect(
        fixture.service.reply({ principalId: "principal-a" }, reply),
      ).resolves.toMatchObject({ replayed: true });
      await expect(
        fixture.service.reply(
          { principalId: "principal-a" },
          {
            ...reply,
            answer: { "Which color should be used?": "Red" },
          },
        ),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      await expect(
        fixture.service.reply(
          { principalId: "principal-a" },
          { ...reply, operationId: "native-question-same-answer" },
        ),
      ).resolves.toMatchObject({ replayed: true });
      await expect(
        fixture.service.reply(
          { principalId: "principal-a" },
          {
            ...reply,
            operationId: "native-question-conflict",
            answer: { "Which color should be used?": "Red" },
          },
        ),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      await expect(delivery).resolves.toEqual({
        "Which color should be used?": "Blue",
      });

      await expect(
        fixture.service.getTask(
          { principalId: "principal-a" },
          { taskId: submitted.task.taskId },
        ),
      ).resolves.toMatchObject({
        state: "awaiting_input",
        question: { state: "accepted", delivery: "pending" },
      });
      await worker.acknowledgeQuestionDelivery(nativeIdentity);
      await expect(
        fixture.service.getTask(
          { principalId: "principal-a" },
          { taskId: submitted.task.taskId },
        ),
      ).resolves.toMatchObject({
        state: "running",
        question: { state: "closed", delivery: "acknowledged" },
        execution: { state: "running" },
      });
      await expect(
        fixture.store.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({ workspaceClaim: "held" });
      await expect(
        worker.emit(
          encodeWorkerObservation({
            kind: "candidate",
            reference,
            ordinal: 2,
            finalOrdinal: 2,
            outcome: "succeeded",
            summary: "Question answered",
            sessionReference: null,
          }),
          2,
          "candidate",
        ),
      ).resolves.toBeUndefined();
    } finally {
      worker?.close();
      await ingress?.close();
      await fixture.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps a committed acknowledgement when the ingress response is lost", async () => {
    const fixture = await createDurableAdmissionFixture();
    const directory = await mkdtemp(
      join(tmpdir(), "agentport-question-ack-loss-"),
    );
    let ingress: RuntimeWorkerIngress | undefined;
    let worker: RuntimeWorkerIngressClient | undefined;
    try {
      const submitted = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "native-question-ack-loss-submit",
          agentId: "agent-a",
          instruction: "Ask for a clarification",
        },
      );
      const { reference } = await fixture.service.prepareForDispatch(
        submitted.task.taskId,
        "native-question-ack-loss-epoch",
      );
      await fixture.service.markExecutionRunning(reference);
      ingress = await RuntimeWorkerIngress.open({
        endpoint: join(directory, "worker.sock"),
        reference,
        lifecycle: {
          persistQuestion: (question) =>
            fixture.service.persistRuntimeQuestion(
              submitted.task.taskId,
              question,
            ),
          waitForAcceptedAnswer: (value, identity, signal) =>
            fixture.service.waitForAcceptedQuestionAnswer(
              value,
              identity,
              signal,
            ),
          acknowledgeQuestionDelivery: async (value, identity) => {
            await fixture.service.acknowledgeRuntimeQuestionDelivery(
              value,
              identity,
            );
            throw new Error("simulated lost acknowledgement response");
          },
          markQuestionDeliveryUnknown: (value, identity) =>
            fixture.service.markRuntimeQuestionDeliveryUnknown(value, identity),
          recordObservation: (observation) =>
            fixture.service
              .recordRuntimeObservation(submitted.task.taskId, observation)
              .then(() => undefined),
          stopAfterCandidate: () => Promise.resolve(),
          quarantine: () => Promise.resolve(),
        },
      });
      worker = await RuntimeWorkerIngressClient.connect(ingress.session);
      const identity = {
        questionId: "native-question-ack-loss",
        toolUseId: "tool-native-ack-loss",
        requestId: "request-native-ack-loss",
      };
      await worker.emit(
        encodeWorkerObservation({
          kind: "question",
          reference,
          ordinal: 1,
          ...identity,
          toolActivity: "none",
          questions: schema,
        }),
        1,
        "question",
      );
      const delivery = worker.waitForQuestionAnswer(identity);
      await fixture.service.reply(
        { principalId: "principal-a" },
        {
          operationId: "native-question-ack-loss-reply",
          taskId: submitted.task.taskId,
          questionId: identity.questionId,
          answer: { "Which color should be used?": "Blue" },
        },
      );
      await expect(delivery).resolves.toEqual({
        "Which color should be used?": "Blue",
      });

      await expect(
        worker.acknowledgeQuestionDelivery(identity),
      ).rejects.toThrow();
      await expect
        .poll(async () => {
          const task = await fixture.service.getTask(
            { principalId: "principal-a" },
            { taskId: submitted.task.taskId },
          );
          return {
            state: task.state,
            questionState: task.question?.state,
            delivery: task.question?.delivery,
          };
        })
        .toEqual({
          state: "running",
          questionState: "closed",
          delivery: "acknowledged",
        });
      await expect(
        fixture.store.getQuestionForDelivery({
          reference,
          ...identity,
          now: "2026-09-12T08:00:00.000Z",
        }),
      ).resolves.toBeUndefined();
    } finally {
      worker?.close();
      await ingress?.close();
      await fixture.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("closes an expired pending Question and never makes it deliverable", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const { taskId, reference, identity } = await startQuestion(
        fixture,
        "native-question-expiry",
        1,
      );
      await expect(
        fixture.service.reply(
          { principalId: "principal-a" },
          {
            operationId: "native-question-invalid-answer",
            taskId,
            questionId: identity.questionId,
            answer: { "Which color should be used?": "Green" },
          },
        ),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      await expect(
        fixture.store.replyToQuestion({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          expectedRegistryRevision: 1,
          operationId: "native-question-expired-answer",
          fingerprint: "native-question-expired-answer",
          principalId: "principal-a",
          taskId,
          questionId: identity.questionId,
          answer: { "Which color should be used?": "Blue" },
          now: "2026-09-12T08:00:02.000Z",
        }),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      await expect(
        fixture.store.getTaskProjection({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId,
        }),
      ).resolves.toMatchObject({
        task: { state: "awaiting_input" },
        question: { state: "closed", delivery: "pending" },
      });
      await expect(
        fixture.store.getQuestionForDelivery({
          reference,
          ...identity,
          now: "2026-09-12T08:00:02.000Z",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("returns a durable input timeout to the worker so it can fail and stop the Task", async () => {
    let now = new Date("2026-09-12T08:00:00.000Z");
    const fixture = await createDurableAdmissionFixture({}, { now: () => now });
    const directory = await mkdtemp(join(tmpdir(), "agentport-input-timeout-"));
    let ingress: RuntimeWorkerIngress | undefined;
    let worker: RuntimeWorkerIngressClient | undefined;
    try {
      const submitted = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "input-timeout-submit",
          agentId: "agent-a",
          instruction: "Wait for bounded input",
          inputWaitSeconds: 1,
        },
      );
      const { reference } = await fixture.service.prepareForDispatch(
        submitted.task.taskId,
        "input-timeout-epoch",
      );
      await fixture.service.markExecutionRunning(reference);
      ingress = await RuntimeWorkerIngress.open({
        endpoint: join(directory, "worker.sock"),
        reference,
        lifecycle: {
          persistQuestion: (question) =>
            fixture.service.persistRuntimeQuestion(
              submitted.task.taskId,
              question,
            ),
          waitForAcceptedAnswer: (value, identity, signal) =>
            fixture.service.waitForAcceptedQuestionAnswer(
              value,
              identity,
              signal,
            ),
          acknowledgeQuestionDelivery: (value, identity) =>
            fixture.service.acknowledgeRuntimeQuestionDelivery(value, identity),
          markQuestionDeliveryUnknown: (value, identity) =>
            fixture.service.markRuntimeQuestionDeliveryUnknown(value, identity),
          recordObservation: (observation) =>
            fixture.service
              .recordRuntimeObservation(submitted.task.taskId, observation)
              .then(() => undefined),
          stopAfterCandidate: () => Promise.resolve(),
          quarantine: () => Promise.resolve(),
        },
      });
      worker = await RuntimeWorkerIngressClient.connect(ingress.session);
      const identity = {
        questionId: "input-timeout-question",
        toolUseId: "input-timeout-tool",
        requestId: "input-timeout-request",
      };
      await worker.emit(
        encodeWorkerObservation({
          kind: "question",
          reference,
          ordinal: 1,
          ...identity,
          toolActivity: "none",
          questions: schema,
        }),
        1,
        "question",
      );
      now = new Date("2026-09-12T08:00:02.000Z");
      await expect(
        worker.waitForQuestionAnswer(identity),
      ).rejects.toBeInstanceOf(RuntimeInputTimeoutError);
      await worker.emit(
        encodeWorkerObservation({
          kind: "candidate",
          reference,
          ordinal: 2,
          finalOrdinal: 2,
          outcome: "failed",
          summary: "input_timeout",
          sessionReference: null,
        }),
        2,
        "candidate",
      );
      await expect(
        fixture.service.getTask(
          { principalId: "principal-a" },
          { taskId: submitted.task.taskId },
        ),
      ).resolves.toMatchObject({
        state: "stopping",
        question: { state: "closed", closureReason: "expired" },
        execution: { stopReason: "completion" },
      });
    } finally {
      worker?.close();
      await ingress?.close();
      await fixture.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not redeliver or synthesize acknowledgement after worker loss or cancellation", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const lost = await startQuestion(fixture, "native-question-lost");
      await fixture.service.reply(
        { principalId: "principal-a" },
        {
          operationId: "native-question-lost-reply",
          taskId: lost.taskId,
          questionId: lost.identity.questionId,
          answer: { "Which color should be used?": "Blue" },
        },
      );
      await fixture.service.markRuntimeQuestionDeliveryUnknown(
        lost.reference,
        lost.identity,
      );
      await expect(
        fixture.store.getQuestionForDelivery({
          reference: lost.reference,
          ...lost.identity,
          now: "2026-09-12T08:00:00.000Z",
        }),
      ).resolves.toBeUndefined();
      await expect(
        fixture.service.acknowledgeRuntimeQuestionDelivery(
          lost.reference,
          lost.identity,
        ),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      await expect(
        fixture.service.getTask(
          { principalId: "principal-a" },
          { taskId: lost.taskId },
        ),
      ).resolves.toMatchObject({
        state: "awaiting_input",
        question: { state: "accepted", delivery: "unknown" },
      });

      const canceled = await startQuestion(
        fixture,
        "native-question-canceled",
        86_400,
        "agent-revokable",
      );
      await fixture.service.reply(
        { principalId: "principal-a" },
        {
          operationId: "native-question-canceled-reply",
          taskId: canceled.taskId,
          questionId: canceled.identity.questionId,
          answer: { "Which color should be used?": "Red" },
        },
      );
      await expect(
        fixture.service.cancelTask(
          { principalId: "principal-a" },
          {
            operationId: "native-question-cancel",
            taskId: canceled.taskId,
          },
        ),
      ).resolves.toMatchObject({
        task: {
          state: "stopping",
          question: { state: "closed", delivery: "unknown" },
        },
      });
      await expect(
        fixture.service.acknowledgeRuntimeQuestionDelivery(
          canceled.reference,
          canceled.identity,
        ),
      ).rejects.toMatchObject({ code: "operation_conflict" });
    } finally {
      await fixture.close();
    }
  });
});
