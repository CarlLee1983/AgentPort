import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProductAuditSnapshot } from "../../src/storage/sqlite-durable-admission-store.js";
import {
  createDurableAdmissionFixture,
  INVALID_TOKEN,
  SCOPE_A_TOKEN,
  SCOPE_B_TOKEN,
} from "../fixtures/durable-admission.js";
import {
  connectDurableAdmissionClient,
  expectStructuredTextAgreement,
  startDurableAdmissionMcpEndpoint,
} from "../fixtures/durable-admission-mcp.js";

const SHARED_TOKEN = "ap013-shared-scope-token";
const PRIVATE_PROMPT = "AP013-PRIVATE-PROMPT";
const PRIVATE_QUESTION = "AP013-PRIVATE-QUESTION";
const PRIVATE_ANSWER = "AP013-PRIVATE-ANSWER";
const TOOL_NAMES = [
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
] as const;

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
type DurabilityCounts = {
  bindingSnapshots: number;
  contexts: number;
  receipts: number;
  actors: string[];
  reservations: number;
};
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

function structured(result: ToolResult): Record<string, unknown> {
  expectStructuredTextAgreement(result);
  expect(result.structuredContent).toBeTypeOf("object");
  return result.structuredContent as Record<string, unknown>;
}

function acceptedTask(result: ToolResult): Record<string, unknown> {
  const payload = structured(result);
  expect(result.isError).not.toBe(true);
  expect(payload.ok).toBe(true);
  expect(payload.task).toBeTypeOf("object");
  return payload.task as Record<string, unknown>;
}

function rejected(
  result: ToolResult,
  code: string,
  privateMarkers: readonly string[],
): void {
  expect(result.isError).toBe(true);
  expect(structured(result)).toMatchObject({
    ok: false,
    error: { code, retryable: false, safeRetry: "none" },
  });
  for (const marker of privateMarkers)
    expect(JSON.stringify(result)).not.toContain(marker);
}

describe("AP-013 S5 MCP authorization matrix", () => {
  it("attributes permitted same-Scope handoffs and denies all ten tools after membership revocation", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const sharedConfiguration = {
      ...fixture.registryConfiguration,
      credentials: {
        ...fixture.registryConfiguration.credentials,
        [SHARED_TOKEN]: "principal-shared",
      },
      principals: [
        ...fixture.registryConfiguration.principals,
        {
          principalId: "principal-shared",
          accessScopeId: "scope-a",
          active: true,
          allowedAgentIds: ["agent-a", "agent-revokable"],
        },
      ],
    };
    await fixture.registry.replace(sharedConfiguration);
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const creator = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const shared = track(
      await connectDurableAdmissionClient(endpoint.url, SHARED_TOKEN),
    );

    expect(
      (await shared.listTools()).tools.map(({ name }) => name).sort(),
    ).toEqual(TOOL_NAMES);
    const original = acceptedTask(
      await creator.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap013-creator-submit",
          agentId: "agent-a",
          instruction: PRIVATE_PROMPT,
        },
      }),
    );
    const taskId = String(original.taskId);
    const contextId = String(original.contextId);
    const edit = acceptedTask(
      await shared.callTool({
        name: "agentport_edit_task",
        arguments: {
          operationId: "ap013-shared-edit",
          taskId,
          expectedRevision: original.revision,
          instruction: PRIVATE_PROMPT,
        },
      }),
    );
    expect(edit).toMatchObject({ taskId, revision: 2 });
    const followUp = acceptedTask(
      await shared.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap013-shared-follow-up",
          agentId: "agent-a",
          instruction: "An independent shared-scope Task",
        },
      }),
    );
    expect(followUp.contextId).not.toBe(contextId);
    acceptedTask(
      await shared.callTool({
        name: "agentport_cancel_task",
        arguments: {
          operationId: "ap013-shared-cancel",
          taskId: followUp.taskId,
        },
      }),
    );

    const agents = structured(
      await shared.callTool({ name: "agentport_list_agents", arguments: {} }),
    );
    expect(agents.agents).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: "agent-a" })]),
    );
    expect(
      structured(
        await shared.callTool({
          name: "agentport_list_tasks",
          arguments: { agentId: "agent-a" },
        }),
      ).tasks,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ taskId })]));
    expect(
      structured(
        await shared.callTool({
          name: "agentport_get_events",
          arguments: { taskId },
        }),
      ).events,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ taskId })]));
    expect(
      acceptedTask(
        await shared.callTool({
          name: "agentport_get_task",
          arguments: { taskId },
        }),
      ).instruction,
    ).toBe(PRIVATE_PROMPT);

    const dispatch = vi.spyOn(fixture.service, "prepareForDispatch");
    const { reference } = await fixture.service.prepareForDispatch(
      taskId,
      "ap013-question-epoch",
    );
    await fixture.service.markExecutionRunning(reference);
    await fixture.store.persistQuestionObservation({
      reference,
      questionId: "ap013-question",
      toolUseId: "ap013-tool-use",
      requestId: "ap013-request",
      ordinal: 1,
      toolActivity: "none",
      activeElapsedMs: 0,
      schema: [
        {
          question: PRIVATE_QUESTION,
          header: "Choice",
          options: [
            { label: PRIVATE_ANSWER, description: "Private choice" },
            { label: "Other", description: "Other choice" },
          ],
          multiSelect: false,
        },
      ],
      expiresAt: "2026-09-15T00:00:00.000Z",
      now: "2026-09-14T00:00:00.000Z",
    });
    const replied = acceptedTask(
      await shared.callTool({
        name: "agentport_reply",
        arguments: {
          operationId: "ap013-shared-reply",
          taskId,
          questionId: "ap013-question",
          answer: { [PRIVATE_QUESTION]: PRIVATE_ANSWER },
        },
      }),
    );
    expect(replied.question).toMatchObject({
      state: "accepted",
      answer: { [PRIVATE_QUESTION]: PRIVATE_ANSWER },
    });
    const afterReplyEvents = await shared.callTool({
      name: "agentport_get_events",
      arguments: { taskId },
    });
    for (const marker of [PRIVATE_PROMPT, PRIVATE_QUESTION, PRIVATE_ANSWER])
      expect(JSON.stringify(afterReplyEvents)).not.toContain(marker);

    const notBlocked = await shared.callTool({
      name: "agentport_resume_context",
      arguments: {
        operationId: "ap013-not-blocked-resume",
        contextId,
        expectedRevision: replied.contextRevision,
        continuationMode: "fresh_session",
        contextSummary: "No blocker to resume",
      },
    });
    expect(structured(notBlocked)).toMatchObject({
      ok: false,
      error: { code: "invalid_state" },
    });
    const notStopped = await shared.callTool({
      name: "agentport_acknowledge_interruption",
      arguments: {
        operationId: "ap013-not-stopped-ack",
        taskId,
        expectedRevision: replied.revision,
      },
    });
    expect(structured(notStopped)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });

    const revokedCalls = [
      { name: "agentport_list_agents", arguments: {} },
      {
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap013-revoked-submit",
          agentId: "agent-a",
          instruction: PRIVATE_PROMPT,
        },
      },
      {
        name: "agentport_edit_task",
        arguments: {
          operationId: "ap013-revoked-edit",
          taskId,
          expectedRevision: replied.revision,
          instruction: PRIVATE_PROMPT,
        },
      },
      {
        name: "agentport_reply",
        arguments: {
          operationId: "ap013-revoked-reply",
          taskId,
          questionId: "ap013-question",
          answer: { [PRIVATE_QUESTION]: PRIVATE_ANSWER },
        },
      },
      {
        name: "agentport_resume_context",
        arguments: {
          operationId: "ap013-revoked-resume",
          contextId,
          expectedRevision: replied.contextRevision,
          continuationMode: "fresh_session",
          contextSummary: PRIVATE_PROMPT,
        },
      },
      {
        name: "agentport_acknowledge_interruption",
        arguments: {
          operationId: "ap013-revoked-ack",
          taskId,
          expectedRevision: replied.revision,
        },
      },
      { name: "agentport_get_task", arguments: { taskId } },
      {
        name: "agentport_list_tasks",
        arguments: { agentId: "agent-a" },
      },
      { name: "agentport_get_events", arguments: { taskId } },
      {
        name: "agentport_cancel_task",
        arguments: { operationId: "ap013-revoked-cancel", taskId },
      },
    ] satisfies Array<{ name: string; arguments: Record<string, unknown> }>;
    expect(revokedCalls.map(({ name }) => name).sort()).toEqual(TOOL_NAMES);
    const durableBeforeDenial = (await fixture.store.probe(
      "inspectDurability",
    )) as DurabilityCounts;
    expect(durableBeforeDenial.actors).toEqual(
      expect.arrayContaining(["principal-a", "principal-shared"]),
    );
    await fixture.registry.replace({
      ...sharedConfiguration,
      principals: sharedConfiguration.principals.map((principal) =>
        principal.principalId === "principal-shared"
          ? { ...principal, allowedAgentIds: ["agent-revokable"] }
          : principal,
      ),
    });
    for (const call of revokedCalls) {
      const result = await shared.callTool(call);
      if (call.name === "agentport_list_agents") {
        expect(structured(result).agents).toEqual([
          expect.objectContaining({ agentId: "agent-revokable" }),
        ]);
      } else {
        rejected(result, "not_found", [
          PRIVATE_PROMPT,
          PRIVATE_QUESTION,
          PRIVATE_ANSWER,
          taskId,
          contextId,
        ]);
      }
    }
    expect(
      (await fixture.store.probe("inspectDurability")) as DurabilityCounts,
    ).toMatchObject(durableBeforeDenial);
    await fixture.registry.replace({
      ...sharedConfiguration,
      principals: sharedConfiguration.principals.map((principal) =>
        principal.principalId === "principal-shared"
          ? { ...principal, active: false }
          : principal,
      ),
    });
    for (const call of revokedCalls) {
      rejected(await shared.callTool(call), "access_denied", [
        PRIVATE_PROMPT,
        PRIVATE_QUESTION,
        PRIVATE_ANSWER,
        taskId,
        contextId,
        SHARED_TOKEN,
      ]);
    }
    expect(
      (await fixture.store.probe("inspectDurability")) as DurabilityCounts,
    ).toMatchObject(durableBeforeDenial);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await endpoint.flushAudit();
    const audit = (await fixture.store.probe(
      "inspectProductAudit",
    )) as ProductAuditSnapshot;
    const sharedCalls = audit.records.filter(
      ({ principalId, method }) =>
        principalId === "principal-shared" && method === "tools/call",
    );
    expect(
      sharedCalls
        .filter(({ resultCode }) => resultCode === "access_denied")
        .map(({ toolName }) => toolName)
        .sort(),
    ).toEqual(TOOL_NAMES);
    expect(sharedCalls.map(({ toolName }) => toolName).filter(Boolean)).toEqual(
      expect.arrayContaining([...TOOL_NAMES]),
    );
    for (const toolName of [
      "agentport_edit_task",
      "agentport_submit_task",
      "agentport_cancel_task",
      "agentport_reply",
      "agentport_get_task",
      "agentport_get_events",
      "agentport_list_agents",
      "agentport_list_tasks",
    ]) {
      expect(sharedCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ toolName, resultCode: "ok" }),
        ]),
      );
    }
    expect(audit.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          principalId: "principal-a",
          toolName: "agentport_submit_task",
          resultCode: "ok",
        }),
      ]),
    );
    for (const marker of [
      PRIVATE_PROMPT,
      PRIVATE_QUESTION,
      PRIVATE_ANSWER,
      taskId,
      contextId,
      SHARED_TOKEN,
      fixture.directory,
    ]) {
      expect(JSON.stringify(audit)).not.toContain(marker);
    }
    expect(endpoint.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "tools/call",
          principalId: "principal-shared",
        }),
      ]),
    );
  });

  it("conceals foreign Agent, Task, Context, Question and cursor identities without durable side effects", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const clientA = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const clientB = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_B_TOKEN),
    );
    const foreign = acceptedTask(
      await clientB.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap013-foreign-submit",
          agentId: "agent-b",
          instruction: PRIVATE_PROMPT,
        },
      }),
    );
    const foreignTaskId = String(foreign.taskId);
    const foreignContextId = String(foreign.contextId);
    const { reference } = await fixture.service.prepareForDispatch(
      foreignTaskId,
      "ap013-foreign-question-epoch",
    );
    await fixture.service.markExecutionRunning(reference);
    await fixture.store.persistQuestionObservation({
      reference,
      questionId: "ap013-foreign-question",
      toolUseId: "ap013-foreign-tool-use",
      requestId: "ap013-foreign-request",
      ordinal: 1,
      toolActivity: "none",
      activeElapsedMs: 0,
      schema: [
        {
          question: PRIVATE_QUESTION,
          header: "Choice",
          options: [
            { label: PRIVATE_ANSWER, description: "Private choice" },
            { label: "Other", description: "Other choice" },
          ],
          multiSelect: false,
        },
      ],
      expiresAt: "2026-09-15T00:00:00.000Z",
      now: "2026-09-14T00:00:00.000Z",
    });
    acceptedTask(
      await clientB.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap013-foreign-second",
          agentId: "agent-b",
          instruction: "Another foreign Task",
        },
      }),
    );
    const foreignTaskCursor = structured(
      await clientB.callTool({
        name: "agentport_list_tasks",
        arguments: { limit: 1 },
      }),
    ).nextCursor;
    const foreignEventCursor = structured(
      await clientB.callTool({
        name: "agentport_get_events",
        arguments: { limit: 1 },
      }),
    ).nextCursor;
    expect(foreignTaskCursor).toBeTypeOf("string");
    expect(foreignEventCursor).toBeTypeOf("string");
    const dispatch = vi.spyOn(fixture.service, "prepareForDispatch");
    const durableBeforeDenial = (await fixture.store.probe(
      "inspectDurability",
    )) as DurabilityCounts;
    const foreignCalls = [
      {
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap013-foreign-agent",
          agentId: "agent-b",
          instruction: "Must not submit",
        },
      },
      {
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap013-foreign-context",
          agentId: "agent-a",
          contextId: foreignContextId,
          instruction: "Must not join the Context",
        },
      },
      {
        name: "agentport_edit_task",
        arguments: {
          operationId: "ap013-foreign-edit",
          taskId: foreignTaskId,
          expectedRevision: foreign.revision,
          instruction: "Must not edit",
        },
      },
      {
        name: "agentport_reply",
        arguments: {
          operationId: "ap013-foreign-reply",
          taskId: foreignTaskId,
          questionId: "ap013-foreign-question",
          answer: { [PRIVATE_QUESTION]: PRIVATE_ANSWER },
        },
      },
      {
        name: "agentport_resume_context",
        arguments: {
          operationId: "ap013-foreign-resume",
          contextId: foreignContextId,
          expectedRevision: foreign.contextRevision,
          continuationMode: "fresh_session",
          contextSummary: PRIVATE_PROMPT,
        },
      },
      {
        name: "agentport_acknowledge_interruption",
        arguments: {
          operationId: "ap013-foreign-ack",
          taskId: foreignTaskId,
          expectedRevision: foreign.revision,
        },
      },
      { name: "agentport_get_task", arguments: { taskId: foreignTaskId } },
      {
        name: "agentport_list_tasks",
        arguments: { agentId: "agent-b" },
      },
      {
        name: "agentport_list_tasks",
        arguments: { cursor: foreignTaskCursor },
      },
      {
        name: "agentport_get_events",
        arguments: { taskId: foreignTaskId },
      },
      {
        name: "agentport_get_events",
        arguments: { afterCursor: foreignEventCursor },
      },
      {
        name: "agentport_cancel_task",
        arguments: {
          operationId: "ap013-foreign-cancel",
          taskId: foreignTaskId,
        },
      },
      {
        name: "agentport_list_agents",
        arguments: { cursor: "unknown-agent-cursor" },
      },
    ] satisfies Array<{ name: string; arguments: Record<string, unknown> }>;
    const markers = [
      PRIVATE_PROMPT,
      PRIVATE_QUESTION,
      PRIVATE_ANSWER,
      foreignTaskId,
      foreignContextId,
      "ap013-foreign-question",
      SCOPE_B_TOKEN,
    ];
    for (const call of foreignCalls)
      rejected(await clientA.callTool(call), "not_found", markers);
    expect(
      (await fixture.store.probe("inspectDurability")) as DurabilityCounts,
    ).toMatchObject(durableBeforeDenial);
    const unknown = await clientA.callTool({
      name: "agentport_get_task",
      arguments: { taskId: "unknown-protected-task" },
    });
    rejected(unknown, "not_found", markers);
    expect(
      structured(
        await clientA.callTool({
          name: "agentport_get_task",
          arguments: { taskId: foreignTaskId },
        }),
      ),
    ).toEqual(structured(unknown));
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      await fixture.service.listTasks({ principalId: "principal-a" }, {}),
    ).toMatchObject({ tasks: [] });
    expect(
      await fixture.service.getTask(
        { principalId: "principal-b" },
        { taskId: foreignTaskId },
      ),
    ).toMatchObject({
      state: "awaiting_input",
      question: { state: "pending", delivery: "pending" },
    });
    await endpoint.flushAudit();
    const audit = (await fixture.store.probe(
      "inspectProductAudit",
    )) as ProductAuditSnapshot;
    for (const marker of [...markers, fixture.directory])
      expect(JSON.stringify(audit)).not.toContain(marker);
    expect(
      audit.records
        .filter(
          ({ principalId, resultCode }) =>
            principalId === "principal-a" && resultCode === "not_found",
        )
        .map(({ toolName }) => toolName),
    ).toEqual(expect.arrayContaining(foreignCalls.map(({ name }) => name)));

    const retryWithoutForeignContext = acceptedTask(
      await clientA.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap013-foreign-context",
          agentId: "agent-a",
          instruction: "A new authorized Context",
        },
      }),
    );
    expect(retryWithoutForeignContext.contextId).not.toBe(foreignContextId);
  });

  it("keeps protocol failures side-effect free and returns a failed Task as an authorized query", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const actor = { principalId: "principal-a" };
    const failed = await fixture.service.submitTask(actor, {
      operationId: "ap013-failed-task-submit",
      agentId: "agent-a",
      instruction: PRIVATE_PROMPT,
    });
    const { reference } = await fixture.service.prepareForDispatch(
      failed.task.taskId,
      "ap013-failed-task-epoch",
    );
    await fixture.service.markExecutionRunning(reference);
    await fixture.recordObservation(actor, {
      taskId: failed.task.taskId,
      observation: {
        kind: "candidate",
        reference,
        ordinal: 1,
        finalOrdinal: 1,
        outcome: { kind: "failed", summary: "Bounded failure" },
        sessionReference: null,
      },
    });
    await fixture.store.commitTerminal({
      evidence: {
        platform: "linux-cgroup-v2",
        reference,
        executionUnitId: "ap013-failed-unit",
        generationSealedAt: "2026-09-14T00:00:01.000Z",
        unitEmptyObservedAt: "2026-09-14T00:00:02.000Z",
      },
    });
    const queried = await client.callTool({
      name: "agentport_get_task",
      arguments: { taskId: failed.task.taskId },
    });
    expect(queried.isError).not.toBe(true);
    expect(acceptedTask(queried)).toMatchObject({
      taskId: failed.task.taskId,
      state: "failed",
      instruction: PRIVATE_PROMPT,
    });
    const events = await client.callTool({
      name: "agentport_get_events",
      arguments: { taskId: failed.task.taskId },
    });
    expect(JSON.stringify(events)).not.toContain(PRIVATE_PROMPT);

    const logChunks: string[] = [];
    const capture = ((chunk: string | Uint8Array): boolean => {
      logChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(capture);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(capture);
    try {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      const [missing, invalid] = await Promise.all([
        fetch(endpoint.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
        fetch(endpoint.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${INVALID_TOKEN}`,
            "content-type": "application/json",
          },
          body,
        }),
      ]);
      expect([missing.status, invalid.status]).toEqual([401, 401]);
      expect(`${await missing.text()}${await invalid.text()}`).not.toContain(
        INVALID_TOKEN,
      );
      let unknownError: unknown;
      try {
        await client.callTool({
          name: "AP013-UNKNOWN-TOOL-SECRET",
          arguments: {},
        });
      } catch (error) {
        unknownError = error;
      }
      expect(unknownError).toMatchObject({ code: -32_602 });
      expect(String(unknownError)).not.toContain("AP013-UNKNOWN-TOOL-SECRET");
      const malformed = await client.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap013-malformed-submit",
          agentId: "agent-a",
          instruction: "Must not persist",
          credential: "AP013-CREDENTIAL-SECRET",
          workspacePath: "/tmp/ap013-private-path",
        },
      });
      rejected(malformed, "validation_error", [
        "AP013-CREDENTIAL-SECRET",
        "/tmp/ap013-private-path",
      ]);
      expect(await fixture.service.listTasks(actor, {})).toMatchObject({
        tasks: [{ taskId: failed.task.taskId, state: "failed" }],
      });
      const accepted = acceptedTask(
        await client.callTool({
          name: "agentport_submit_task",
          arguments: {
            operationId: "ap013-malformed-submit",
            agentId: "agent-a",
            instruction: "A valid retry after schema rejection",
          },
        }),
      );
      expect(accepted.state).toBe("queued");
      const conflict = await client.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap013-malformed-submit",
          agentId: "agent-a",
          instruction: "Different request under the same operation ID",
        },
      });
      rejected(conflict, "operation_conflict", [PRIVATE_PROMPT]);
      await endpoint.flushAudit();
      const audit = (await fixture.store.probe(
        "inspectProductAudit",
      )) as ProductAuditSnapshot;
      expect(audit.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            principalId: null,
            resultCode: "unauthorized",
          }),
          expect.objectContaining({
            principalId: "principal-a",
            toolName: "agentport_get_task",
            resultCode: "ok",
          }),
          expect.objectContaining({
            principalId: "principal-a",
            toolName: "agentport_submit_task",
            resultCode: "operation_conflict",
          }),
        ]),
      );
      for (const marker of [
        PRIVATE_PROMPT,
        INVALID_TOKEN,
        SCOPE_A_TOKEN,
        "AP013-CREDENTIAL-SECRET",
        "AP013-UNKNOWN-TOOL-SECRET",
        "/tmp/ap013-private-path",
        fixture.directory,
      ]) {
        expect(JSON.stringify(audit)).not.toContain(marker);
        expect(logChunks.join("")).not.toContain(marker);
      }
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
