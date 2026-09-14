import { afterEach, describe, expect, it } from "vitest";

import {
  createDurableAdmissionFixture,
  SCOPE_A_TOKEN,
} from "../fixtures/durable-admission.js";
import {
  connectDurableAdmissionClient,
  startDurableAdmissionMcpEndpoint,
} from "../fixtures/durable-admission-mcp.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(
    resources
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
});

function track<T extends { close(): Promise<void> }>(resource: T): T {
  resources.push(() => resource.close());
  return resource;
}

function structured(result: {
  structuredContent?: unknown;
}): Record<string, unknown> {
  expect(result.structuredContent).toBeTypeOf("object");
  return result.structuredContent as Record<string, unknown>;
}

function task(result: Record<string, unknown>): Record<string, unknown> {
  expect(result.ok).toBe(true);
  expect(result.task).toBeTypeOf("object");
  return result.task as Record<string, unknown>;
}

describe("S4 Context follow-up submission", () => {
  it("publishes all ten bounded core-owned tools", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );

    await expect(
      client
        .listTools()
        .then(({ tools }) => tools.map(({ name }) => name).sort()),
    ).resolves.toEqual([
      "agentport_acknowledge_interruption",
      "agentport_cancel_task",
      "agentport_edit_task",
      "agentport_get_events",
      "agentport_get_task",
      "agentport_list_agents",
      "agentport_list_tasks",
      "agentport_reply",
      "agentport_resume_context",
      "agentport_submit_task",
    ]);
  });

  it("keeps the Context binding and creates an immutable predecessor edge", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );

    const first = task(
      structured(
        await client.callTool({
          name: "agentport_submit_task",
          arguments: {
            operationId: "s4-context-first",
            agentId: "agent-a",
            instruction: "First Context Task",
          },
        }),
      ),
    );
    const followUp = task(
      structured(
        await client.callTool({
          name: "agentport_submit_task",
          arguments: {
            operationId: "s4-context-follow-up",
            agentId: "agent-a",
            contextId: first.contextId,
            instruction: "Follow-up Context Task",
          },
        }),
      ),
    );
    const independent = task(
      structured(
        await client.callTool({
          name: "agentport_submit_task",
          arguments: {
            operationId: "s4-context-independent",
            agentId: "agent-a",
            instruction: "Independent Context Task",
          },
        }),
      ),
    );

    expect(followUp).toMatchObject({
      contextId: first.contextId,
      predecessorTaskId: first.taskId,
      contextRevision: 2,
      agentId: "agent-a",
      state: "queued",
    });
    expect(Number(followUp.queueOrder)).toBeGreaterThan(
      Number(first.queueOrder),
    );
    expect(independent).toMatchObject({ predecessorTaskId: null });
    expect(independent.contextId).not.toBe(first.contextId);
  });

  it("publishes a durable native Question and accepts its first reply through MCP", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const submitted = task(
      structured(
        await client.callTool({
          name: "agentport_submit_task",
          arguments: {
            operationId: "s4-question-submit",
            agentId: "agent-a",
            instruction: "Ask for clarification",
          },
        }),
      ),
    );
    const { reference } = await fixture.service.prepareForDispatch(
      String(submitted.taskId),
      "s4-question-epoch",
    );
    await fixture.service.markExecutionRunning(reference);
    await fixture.store.persistQuestionObservation({
      reference,
      questionId: "s4-mcp-question",
      toolUseId: "s4-mcp-tool-use",
      requestId: "s4-mcp-request",
      ordinal: 1,
      toolActivity: "none",
      activeElapsedMs: 0,
      schema: [
        {
          question: "Choose a color",
          header: "Color",
          options: [
            { label: "Blue", description: "Use blue" },
            { label: "Red", description: "Use red" },
          ],
          multiSelect: false,
        },
      ],
      expiresAt: "2026-09-15T00:00:00.000Z",
      now: "2026-09-14T00:00:00.000Z",
    });

    const published = structured(
      await client.callTool({
        name: "agentport_get_task",
        arguments: { taskId: submitted.taskId },
      }),
    );
    expect(published).toMatchObject({
      ok: true,
      task: {
        state: "awaiting_input",
        question: { questionId: "s4-mcp-question", state: "pending" },
      },
    });

    const replied = structured(
      await client.callTool({
        name: "agentport_reply",
        arguments: {
          operationId: "s4-question-reply",
          taskId: submitted.taskId,
          questionId: "s4-mcp-question",
          answer: { "Choose a color": "Blue" },
        },
      }),
    );
    expect(replied).toMatchObject({
      ok: true,
      replayed: false,
      task: {
        state: "awaiting_input",
        question: { state: "accepted", delivery: "pending" },
      },
    });
  });

  it("edits only a current never-started Task and replays its receipt", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const submitted = task(
      structured(
        await client.callTool({
          name: "agentport_submit_task",
          arguments: {
            operationId: "s4-edit-submit",
            agentId: "agent-a",
            instruction: "Original instruction",
          },
        }),
      ),
    );

    const edited = structured(
      await client.callTool({
        name: "agentport_edit_task",
        arguments: {
          operationId: "s4-edit-operation",
          taskId: submitted.taskId,
          expectedRevision: submitted.revision,
          instruction: "Revised instruction",
        },
      }),
    );
    expect(edited).toMatchObject({
      ok: true,
      replayed: false,
      task: {
        taskId: submitted.taskId,
        instruction: "Revised instruction",
        revision: 2,
      },
    });

    const replay = structured(
      await client.callTool({
        name: "agentport_edit_task",
        arguments: {
          operationId: "s4-edit-operation",
          taskId: submitted.taskId,
          expectedRevision: submitted.revision,
          instruction: "Revised instruction",
        },
      }),
    );
    expect(replay).toMatchObject({ ok: true, replayed: true });

    const stale = structured(
      await client.callTool({
        name: "agentport_edit_task",
        arguments: {
          operationId: "s4-edit-stale",
          taskId: submitted.taskId,
          expectedRevision: submitted.revision,
          instruction: "Stale instruction",
        },
      }),
    );
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "operation_conflict", safeRetry: "none" },
    });

    const unknownQuestion = structured(
      await client.callTool({
        name: "agentport_reply",
        arguments: {
          operationId: "s4-reply-unknown-question",
          taskId: submitted.taskId,
          questionId: "unknown-question",
          answer: { "Unknown question": "Blue" },
        },
      }),
    );
    expect(unknownQuestion).toMatchObject({
      ok: false,
      error: { code: "not_found", safeRetry: "none" },
    });
  });

  it("resumes a named blocker and acknowledges only a trusted stopped interruption through MCP", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const actor = { principalId: "principal-a" };

    const failed = await fixture.service.submitTask(actor, {
      operationId: "s4-mcp-failed-submit",
      agentId: "agent-a",
      instruction: "Fail before the follow-up",
    });
    const successor = await fixture.service.submitTask(actor, {
      operationId: "s4-mcp-successor-submit",
      agentId: "agent-a",
      contextId: failed.task.contextId,
      instruction: "Continue with an explicit summary",
    });
    const { reference: failedReference } =
      await fixture.service.prepareForDispatch(
        failed.task.taskId,
        "s4-mcp-failed-epoch",
      );
    await fixture.service.markExecutionRunning(failedReference);
    await fixture.recordObservation(actor, {
      taskId: failed.task.taskId,
      observation: {
        kind: "candidate",
        reference: failedReference,
        ordinal: 1,
        finalOrdinal: 1,
        outcome: { kind: "failed", summary: "needs an explicit continuation" },
        sessionReference: null,
      },
    });
    await fixture.store.commitTerminal({
      evidence: {
        platform: "linux-cgroup-v2",
        reference: failedReference,
        executionUnitId: "s4-mcp-failed-unit",
        generationSealedAt: "2026-09-14T00:00:01.000Z",
        unitEmptyObservedAt: "2026-09-14T00:00:02.000Z",
      },
    });
    const blocked = await fixture.service.getTask(actor, {
      taskId: successor.task.taskId,
    });
    expect(blocked).toMatchObject({
      state: "paused",
      blocker: { predecessorTaskId: failed.task.taskId, state: "failed" },
    });

    const resumed = structured(
      await client.callTool({
        name: "agentport_resume_context",
        arguments: {
          operationId: "s4-mcp-resume",
          contextId: failed.task.contextId,
          expectedRevision: blocked.contextRevision,
          continuationMode: "fresh_session",
          contextSummary: "Continue without native session continuity.",
        },
      }),
    );
    expect(resumed).toMatchObject({
      ok: true,
      replayed: false,
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

    const interrupted = await fixture.service.submitTask(actor, {
      operationId: "s4-mcp-interrupted-submit",
      agentId: "agent-revokable",
      instruction: "Recover without assuming an outcome",
    });
    const { reference: interruptedReference } =
      await fixture.service.prepareForDispatch(
        interrupted.task.taskId,
        "s4-mcp-interrupted-epoch",
      );
    await fixture.service.markExecutionRunning(interruptedReference);
    await fixture.store.recoverExecutions();
    const recovering = await fixture.service.getTask(actor, {
      taskId: interrupted.task.taskId,
    });
    expect(recovering).toMatchObject({
      state: "recovering",
      execution: { quarantined: true },
    });

    const premature = structured(
      await client.callTool({
        name: "agentport_acknowledge_interruption",
        arguments: {
          operationId: "s4-mcp-premature-interruption",
          taskId: interrupted.task.taskId,
          expectedRevision: recovering.revision,
        },
      }),
    );
    expect(premature).toMatchObject({
      ok: false,
      error: { code: "not_found", safeRetry: "none" },
    });

    await fixture.store.confirmRecoveryStopped({
      evidence: {
        platform: "linux-cgroup-v2",
        reference: interruptedReference,
        executionUnitId: "s4-mcp-interrupted-unit",
        generationSealedAt: "2026-09-14T00:00:03.000Z",
        unitEmptyObservedAt: "2026-09-14T00:00:04.000Z",
      },
      now: "2026-09-14T00:00:05.000Z",
    });
    const acknowledged = structured(
      await client.callTool({
        name: "agentport_acknowledge_interruption",
        arguments: {
          operationId: "s4-mcp-acknowledge-interruption",
          taskId: interrupted.task.taskId,
          expectedRevision: recovering.revision,
        },
      }),
    );
    expect(acknowledged).toMatchObject({
      ok: true,
      replayed: false,
      task: {
        taskId: interrupted.task.taskId,
        state: "interrupted",
        reason: "outcome_unknown",
        execution: { state: "interrupted", quarantined: false },
      },
    });
    const replay = structured(
      await client.callTool({
        name: "agentport_acknowledge_interruption",
        arguments: {
          operationId: "s4-mcp-acknowledge-interruption",
          taskId: interrupted.task.taskId,
          expectedRevision: recovering.revision,
        },
      }),
    );
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      task: { state: "interrupted" },
    });
  });
});
