import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDurableAdmissionFixture,
  SCOPE_A_TOKEN,
  SCOPE_B_TOKEN,
} from "../fixtures/durable-admission.js";
import {
  connectDurableAdmissionClient,
  expectStructuredTextAgreement,
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

function task(result: {
  structuredContent?: unknown;
}): Record<string, unknown> {
  const payload = structured(result);
  expect(payload.ok).toBe(true);
  expect(payload.task).toBeTypeOf("object");
  return payload.task as Record<string, unknown>;
}

function expectRejected(
  result: {
    isError?: boolean | undefined;
    content: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
  },
  code: "access_denied" | "not_found" | "validation_error",
  secrets: readonly string[],
): void {
  expect(result.isError).toBe(true);
  expectStructuredTextAgreement(result);
  expect(structured(result)).toMatchObject({
    ok: false,
    error: { code, retryable: false, safeRetry: "none" },
  });
  for (const secret of secrets)
    expect(JSON.stringify(result)).not.toContain(secret);
}

describe("AP-008 S4 authorization boundary", () => {
  it("conceals foreign Context, Task, and Question identities without mutating or delivering", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const clientA = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const clientB = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_B_TOKEN),
    );
    const foreign = task(
      await clientB.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "s4-scope-b-submit",
          agentId: "agent-b",
          instruction: "S4-SCOPE-B-INSTRUCTION",
        },
      }),
    );
    const { reference } = await fixture.service.prepareForDispatch(
      String(foreign.taskId),
      "s4-scope-b-epoch",
    );
    await fixture.service.markExecutionRunning(reference);
    await fixture.store.persistQuestionObservation({
      reference,
      questionId: "s4-scope-b-question",
      toolUseId: "s4-scope-b-tool-use",
      requestId: "s4-scope-b-request",
      ordinal: 1,
      toolActivity: "none",
      activeElapsedMs: 0,
      schema: [
        {
          question: "S4-SCOPE-B-QUESTION",
          header: "Scope B",
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
    const foreignTaskId = String(foreign.taskId);
    const foreignContextId = String(foreign.contextId);
    const secrets = [
      foreignTaskId,
      foreignContextId,
      "s4-scope-b-question",
      "S4-SCOPE-B-INSTRUCTION",
      "S4-SCOPE-B-QUESTION",
    ];
    const delivery = vi.spyOn(fixture.store, "getQuestionForDelivery");

    const attempts = await Promise.all([
      clientA.callTool({
        name: "agentport_get_task",
        arguments: { taskId: foreignTaskId },
      }),
      clientA.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "s4-cross-context",
          agentId: "agent-a",
          contextId: foreignContextId,
          instruction: "must not join foreign Context",
        },
      }),
      clientA.callTool({
        name: "agentport_edit_task",
        arguments: {
          operationId: "s4-cross-edit",
          taskId: foreignTaskId,
          expectedRevision: foreign.revision,
          instruction: "must not edit foreign Task",
        },
      }),
      clientA.callTool({
        name: "agentport_reply",
        arguments: {
          operationId: "s4-cross-reply",
          taskId: foreignTaskId,
          questionId: "s4-scope-b-question",
          answer: { "S4-SCOPE-B-QUESTION": "Blue" },
        },
      }),
    ]);
    for (const result of attempts) expectRejected(result, "not_found", secrets);

    expect(delivery).not.toHaveBeenCalled();
    await expect(
      fixture.service.getTask(
        { principalId: "principal-b" },
        { taskId: foreignTaskId },
      ),
    ).resolves.toMatchObject({
      state: "awaiting_input",
      question: {
        questionId: "s4-scope-b-question",
        state: "pending",
        delivery: "pending",
      },
    });
    await expect(
      fixture.service.listTasks({ principalId: "principal-a" }, {}),
    ).resolves.toMatchObject({ tasks: [] });
  });

  it("rejects caller- and worker-spoofed binding and runtime fields before side effects", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const dispatch = vi.spyOn(fixture.service, "prepareForDispatch");
    const delivery = vi.spyOn(fixture.store, "getQuestionForDelivery");
    const spoofedFields: Array<Record<string, unknown>> = [
      { predecessorTaskId: "caller-selected-predecessor" },
      { questionId: "worker-created-question" },
      { answerSchema: { arbitrary: "schema" } },
      { sessionReference: "caller-selected-session" },
      { executionReference: "caller-selected-execution" },
      { workspaceId: "caller-selected-workspace" },
      { runtimeOptions: { unsafe: true } },
      { credential: "S4-CREDENTIAL-SENTINEL" },
      { worker: { question: "spoofed-native-question" } },
    ];

    for (const [index, fields] of spoofedFields.entries()) {
      const result = await client.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: `s4-spoof-${String(index)}`,
          agentId: "agent-a",
          instruction: "must not persist",
          ...fields,
        },
      });
      expectRejected(result, "validation_error", [
        "caller-selected-predecessor",
        "worker-created-question",
        "caller-selected-session",
        "caller-selected-execution",
        "caller-selected-workspace",
        "S4-CREDENTIAL-SENTINEL",
        "spoofed-native-question",
      ]);
    }

    expect(dispatch).not.toHaveBeenCalled();
    expect(delivery).not.toHaveBeenCalled();
    await expect(
      fixture.service.listTasks({ principalId: "principal-a" }, {}),
    ).resolves.toMatchObject({ tasks: [] });
  });

  it("projects an inactive member as access_denied without disclosing its prior Task", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_B_TOKEN),
    );
    const submitted = task(
      await client.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "s4-before-membership-revocation",
          agentId: "agent-b",
          instruction: "S4-REVOKED-INSTRUCTION",
        },
      }),
    );
    await fixture.registry.replace({
      ...fixture.registryConfiguration,
      principals: fixture.registryConfiguration.principals.map((principal) =>
        principal.principalId === "principal-b"
          ? { ...principal, active: false }
          : principal,
      ),
    });

    const result = await client.callTool({
      name: "agentport_get_task",
      arguments: { taskId: submitted.taskId },
    });
    expectRejected(result, "access_denied", [
      String(submitted.taskId),
      "S4-REVOKED-INSTRUCTION",
    ]);
  });
});
