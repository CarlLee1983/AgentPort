import { describe, expect, it } from "vitest";

import { AgentRegistry } from "../../src/bootstrap/registry.js";
import { DurableAgentExecutionService } from "../../src/core/agent-execution-service.js";
import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";
import {
  createDurableAdmissionFixture,
  type DurableAdmissionFixture,
} from "../fixtures/durable-admission.js";

const actor = { principalId: "principal-a" };

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

async function restart(fixture: DurableAdmissionFixture) {
  await fixture.store.close();
  const store = await SqliteDurableAdmissionStore.open({
    databasePath: fixture.databasePath,
  });
  const registry = await AgentRegistry.create(
    fixture.registryConfiguration,
    store,
  );
  const { service } =
    DurableAgentExecutionService.createPlatformNeutralPreparationFixture(
      registry,
      store,
      {
        cursorSecret: "s4-race-restart-cursor-secret",
        newId: () => "s4-race-restart-id",
        now: () => new Date("2026-09-12T08:00:00.000Z"),
      },
    );
  await service.initializeAfterRestart();
  return { service, store };
}

async function startQuestion(fixture: DurableAdmissionFixture) {
  const submitted = await fixture.service.submitTask(actor, {
    operationId: "race-question-submit",
    agentId: "agent-a",
    instruction: "Ask for a clarification",
  });
  const { reference } = await fixture.service.prepareForDispatch(
    submitted.task.taskId,
    "race-question-epoch",
  );
  await fixture.service.markExecutionRunning(reference);
  const identity = {
    questionId: "race-question",
    toolUseId: "race-tool-use",
    requestId: "race-request",
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

describe("S4 durable interaction races", () => {
  it("linearizes dispatch, edit, and cancel at the SQLite commit boundary and recovers the cancel winner", async () => {
    const fixture = await createDurableAdmissionFixture();
    let reopened: Awaited<ReturnType<typeof restart>> | undefined;
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "race-dispatch-submit",
        agentId: "agent-a",
        instruction: "the original instruction",
      });
      await fixture.store.probe("armCommitBarrier");
      const dispatch = fixture.service.prepareForDispatch(
        submitted.task.taskId,
        "race-dispatch-epoch",
      );
      await fixture.store.probe("waitForCommitBarrier");
      const edit = fixture.service.editTask(actor, {
        operationId: "race-edit-after-dispatch",
        taskId: submitted.task.taskId,
        expectedRevision: submitted.task.revision,
        instruction: "must not replace the dispatched instruction",
      });
      const cancel = fixture.service.cancelTask(actor, {
        operationId: "race-cancel-after-dispatch",
        taskId: submitted.task.taskId,
      });
      await fixture.store.probe("releaseCommitBarrier");

      const prepared = await dispatch;
      expect(prepared).toMatchObject({ reference: {} });
      await expect(edit).rejects.toMatchObject({ code: "invalid_state" });
      await expect(cancel).resolves.toMatchObject({
        replayed: false,
        task: { state: "stopping", instruction: "the original instruction" },
      });

      reopened = await restart(fixture);
      await expect(
        reopened.service.getTask(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        instruction: "the original instruction",
        execution: {
          executionId: prepared.reference.executionId,
          stopReason: "cancellation",
        },
      });
    } finally {
      await fixture.store.probe("releaseCommitBarrier").catch(() => undefined);
      await reopened?.store.close();
      await (reopened === undefined ? fixture.close() : undefined);
    }
  });

  it("accepts one answer before a concurrent cancel and never redelivers it after restart", async () => {
    const fixture = await createDurableAdmissionFixture();
    let reopened: Awaited<ReturnType<typeof restart>> | undefined;
    try {
      const question = await startQuestion(fixture);
      await fixture.store.probe("armCommitBarrier");
      const reply = fixture.service.reply(actor, {
        operationId: "race-answer-first",
        taskId: question.taskId,
        questionId: question.identity.questionId,
        answer: { "Which color should be used?": "Blue" },
      });
      await fixture.store.probe("waitForCommitBarrier");
      const cancel = fixture.service.cancelTask(actor, {
        operationId: "race-cancel-after-answer",
        taskId: question.taskId,
      });
      await fixture.store.probe("releaseCommitBarrier");

      await expect(reply).resolves.toMatchObject({
        replayed: false,
        task: { question: { state: "accepted", delivery: "pending" } },
      });
      await expect(cancel).resolves.toMatchObject({
        task: {
          state: "stopping",
          question: { state: "closed", delivery: "unknown" },
        },
      });

      reopened = await restart(fixture);
      await expect(
        reopened.service.getTask(actor, { taskId: question.taskId }),
      ).resolves.toMatchObject({
        question: { state: "closed", delivery: "unknown" },
        execution: { stopReason: "cancellation" },
      });
      await expect(
        reopened.store.getQuestionForDelivery({
          reference: question.reference,
          ...question.identity,
          now: "2026-09-12T08:00:00.000Z",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.store.probe("releaseCommitBarrier").catch(() => undefined);
      await reopened?.store.close();
      await (reopened === undefined ? fixture.close() : undefined);
    }
  });

  it("gives one concurrent resume a durable winner and rejects the stale non-head retry after restart", async () => {
    const fixture = await createDurableAdmissionFixture();
    let reopened: Awaited<ReturnType<typeof restart>> | undefined;
    try {
      const predecessor = await fixture.service.submitTask(actor, {
        operationId: "race-resume-predecessor",
        agentId: "agent-a",
        instruction: "cancel this predecessor",
      });
      const successor = await fixture.service.submitTask(actor, {
        operationId: "race-resume-successor",
        agentId: "agent-a",
        contextId: predecessor.task.contextId,
        instruction: "resume exactly once",
      });
      await fixture.service.cancelTask(actor, {
        operationId: "race-resume-cancel-predecessor",
        taskId: predecessor.task.taskId,
      });
      await fixture.store.probe("armCommitBarrier");
      const first = fixture.service.resumeContext(actor, {
        operationId: "race-resume-first",
        contextId: predecessor.task.contextId,
        expectedRevision: 3,
        continuationMode: "fresh_session",
        contextSummary: "resume from the durable blocker",
      });
      await fixture.store.probe("waitForCommitBarrier");
      const stale = fixture.service.resumeContext(actor, {
        operationId: "race-resume-stale",
        contextId: predecessor.task.contextId,
        expectedRevision: 3,
        continuationMode: "fresh_session",
        contextSummary: "must not replace the committed continuation",
      });
      const staleOutcome = stale.then(
        () => undefined,
        (error: unknown) => error,
      );
      await fixture.store.probe("releaseCommitBarrier");

      await expect(first).resolves.toMatchObject({
        replayed: false,
        task: {
          taskId: successor.task.taskId,
          state: "queued",
          continuation: {
            mode: "fresh_session",
          },
        },
      });
      await expect(staleOutcome).resolves.toMatchObject({
        code: "operation_conflict",
      });

      reopened = await restart(fixture);
      await expect(
        reopened.service.getTask(actor, { taskId: successor.task.taskId }),
      ).resolves.toMatchObject({
        state: "paused",
        continuation: {
          mode: "fresh_session",
          nativeContinuity: "abandoned",
        },
      });
    } finally {
      await fixture.store.probe("releaseCommitBarrier").catch(() => undefined);
      await reopened?.store.close();
      await (reopened === undefined ? fixture.close() : undefined);
    }
  });
});
