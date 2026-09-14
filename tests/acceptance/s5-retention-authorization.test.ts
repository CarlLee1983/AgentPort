import { afterEach, describe, expect, it, vi } from "vitest";

import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";
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
  expect(payload).toMatchObject({ ok: true });
  expect(payload.task).toBeTypeOf("object");
  return payload.task as Record<string, unknown>;
}

function expectSanitized(
  result: {
    isError?: boolean | undefined;
    content: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
  },
  code: "internal_error" | "not_found" | "validation_error",
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

async function completeTask(
  fixture: Awaited<ReturnType<typeof createDurableAdmissionFixture>>,
  taskId: string,
): Promise<void> {
  const preparation = await fixture.service.prepareForDispatch(
    taskId,
    "s5-retention-authorization-epoch",
  );
  await fixture.service.markExecutionRunning(preparation.reference);
  await fixture.recordObservation(
    { principalId: "principal-b" },
    {
      taskId,
      observation: {
        kind: "candidate",
        reference: preparation.reference,
        ordinal: 1,
        finalOrdinal: 1,
        outcome: { kind: "completed", summary: "S5-PRIVATE-RESULT" },
        sessionReference: null,
      },
    },
  );
  await fixture.store.commitTerminal({
    evidence: {
      platform: "linux-cgroup-v2",
      reference: preparation.reference,
      executionUnitId: "s5-retention-authorization-unit",
      generationSealedAt: "2026-09-14T00:00:01.000Z",
      unitEmptyObservedAt: "2026-09-14T00:00:02.000Z",
    },
  });
}

describe("S5 retention authorization through the official MCP Client", () => {
  it("conceals cross-scope expired Task, event, cursor, and retry markers as not_found", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const clientA = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const clientB = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_B_TOKEN),
    );
    const instruction = "S5-SCOPE-B-PRIVATE-PROMPT";
    const operationId = "s5-scope-b-expired-submit";
    const submitted = task(
      await clientB.callTool({
        name: "agentport_submit_task",
        arguments: { operationId, agentId: "agent-b", instruction },
      }),
    );
    const taskId = String(submitted.taskId);

    await completeTask(fixture, taskId);
    await fixture.store.expireRetainedData({
      asOf: "2026-10-15T00:00:00.000Z",
    });

    const attempts = await Promise.all([
      clientA.callTool({
        name: "agentport_get_task",
        arguments: { taskId },
      }),
      clientA.callTool({
        name: "agentport_get_events",
        arguments: { taskId },
      }),
      clientA.callTool({
        name: "agentport_cancel_task",
        arguments: { operationId: "s5-cross-scope-retry", taskId },
      }),
    ]);
    for (const result of attempts) {
      expectSanitized(result, "not_found", [
        taskId,
        operationId,
        instruction,
        "S5-PRIVATE-RESULT",
        "result_expired",
        "cursor_expired",
      ]);
    }
  });

  it("conceals an expired operation after same-scope Agent authorization is revoked", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const operationId = "s5-revoked-agent-cancel";
    const submitted = task(
      await client.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "s5-revoked-agent-submit",
          agentId: "agent-revokable",
          instruction: "S5-REVOKED-AGENT-PRIVATE",
        },
      }),
    );
    const taskId = String(submitted.taskId);
    await client.callTool({
      name: "agentport_cancel_task",
      arguments: { operationId, taskId },
    });
    await fixture.store.expireRetainedData({
      asOf: "2026-10-15T00:00:00.000Z",
    });
    await fixture.registry.replace({
      ...fixture.registryConfiguration,
      principals: fixture.registryConfiguration.principals.map((principal) =>
        principal.principalId === "principal-a"
          ? { ...principal, allowedAgentIds: ["agent-a"] }
          : principal,
      ),
    });

    const replay = await client.callTool({
      name: "agentport_cancel_task",
      arguments: { operationId, taskId },
    });
    expectSanitized(replay, "not_found", [
      taskId,
      operationId,
      "S5-REVOKED-AGENT-PRIVATE",
      "result_expired",
    ]);
  });

  it("sanitizes malformed, cross-scope, and filter-mismatched cursors without persistence mutation", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const clientA = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const clientB = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_B_TOKEN),
    );
    const dispatch = vi.spyOn(fixture.service, "prepareForDispatch");

    await clientA.callTool({
      name: "agentport_submit_task",
      arguments: {
        operationId: "s5-cursor-a-first",
        agentId: "agent-a",
        instruction: "S5-CURSOR-A-FIRST",
      },
    });
    await clientA.callTool({
      name: "agentport_submit_task",
      arguments: {
        operationId: "s5-cursor-a-second",
        agentId: "agent-a",
        instruction: "S5-CURSOR-A-SECOND",
      },
    });
    await clientB.callTool({
      name: "agentport_submit_task",
      arguments: {
        operationId: "s5-cursor-b-first",
        agentId: "agent-b",
        instruction: "S5-CURSOR-B-PRIVATE",
      },
    });
    await clientB.callTool({
      name: "agentport_submit_task",
      arguments: {
        operationId: "s5-cursor-b-second",
        agentId: "agent-b",
        instruction: "S5-CURSOR-B-PRIVATE-SECOND",
      },
    });
    const aCursor = structured(
      await clientA.callTool({
        name: "agentport_list_tasks",
        arguments: { limit: 1 },
      }),
    ).nextCursor;
    const bCursor = structured(
      await clientB.callTool({
        name: "agentport_list_tasks",
        arguments: { limit: 1 },
      }),
    ).nextCursor;
    expect(aCursor).toBeTypeOf("string");
    expect(bCursor).toBeTypeOf("string");

    const attempts = await Promise.all([
      clientA.callTool({
        name: "agentport_list_tasks",
        arguments: { cursor: `${String(aCursor)}tampered` },
      }),
      clientA.callTool({
        name: "agentport_list_tasks",
        arguments: { cursor: bCursor },
      }),
      clientA.callTool({
        name: "agentport_list_tasks",
        arguments: { cursor: aCursor, agentId: "agent-a" },
      }),
    ]);
    for (const result of attempts) {
      expectSanitized(result, "not_found", [
        String(aCursor),
        String(bCursor),
        "S5-CURSOR-B-PRIVATE",
        SCOPE_B_TOKEN,
      ]);
    }
    expect(dispatch).not.toHaveBeenCalled();
    const remaining = await fixture.service.listTasks(
      { principalId: "principal-a" },
      {},
    );
    expect(remaining.tasks).not.toHaveLength(0);
  });

  it("rejects caller retention and cleanup-clock fields and trusted invalid maintenance input before mutation", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const dispatch = vi.spyOn(fixture.service, "prepareForDispatch");
    const privateInstruction = "S5-MAINTENANCE-PRIVATE-PROMPT";

    for (const fields of [
      { retentionDays: -1 },
      { retentionDays: Number.MAX_SAFE_INTEGER },
      { asOf: "2099-01-01T00:00:00.000Z" },
    ]) {
      const result = await client.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: `s5-invalid-public-${String(Object.keys(fields)[0])}`,
          agentId: "agent-a",
          instruction: privateInstruction,
          ...fields,
        },
      });
      expectSanitized(result, "validation_error", [privateInstruction]);
    }
    expect(dispatch).not.toHaveBeenCalled();
    await expect(
      fixture.service.listTasks({ principalId: "principal-a" }, {}),
    ).resolves.toMatchObject({ tasks: [] });

    const valid = await fixture.service.submitTask(
      { principalId: "principal-a" },
      {
        operationId: "s5-maintenance-live",
        agentId: "agent-a",
        instruction: privateInstruction,
      },
    );
    await expect(
      fixture.store.expireRetainedData({
        asOf: "not-a-trusted-cleanup-clock",
      }),
    ).rejects.toThrow("retention request is invalid");
    await expect(
      fixture.store.expireRetainedData({
        asOf: "2026-10-15T00:00:00.000Z",
        batchLimit: 0,
      }),
    ).rejects.toThrow("retention request is invalid");
    expect(
      () =>
        new SqliteDurableAdmissionStore({
          databasePath: fixture.databasePath,
          terminalRetentionDays: -1,
        }),
    ).toThrow("terminalRetentionDays must be a positive safe integer");
    await expect(
      fixture.service.getTask(
        { principalId: "principal-a" },
        { taskId: valid.task.taskId },
      ),
    ).resolves.toMatchObject({ instruction: privateInstruction });
  });

  it("redacts SQLite paths, private prompts, and foreign Task identifiers from unexpected error details", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const foreignTaskId = "s5-other-scope-task-id";
    const privatePrompt = "S5-PRIVATE-PROMPT-IN-ERROR";
    vi.spyOn(fixture.service, "getTask").mockRejectedValue(
      new Error(
        `sqlite failure at ${fixture.databasePath}-wal for ${foreignTaskId}: ${privatePrompt}`,
      ),
    );

    const result = await client.callTool({
      name: "agentport_get_task",
      arguments: { taskId: "s5-requested-task" },
    });
    expectSanitized(result, "internal_error", [
      fixture.databasePath,
      `${fixture.databasePath}-wal`,
      foreignTaskId,
      privatePrompt,
    ]);
  });
});
