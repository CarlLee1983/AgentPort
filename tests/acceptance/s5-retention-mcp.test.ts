import { afterEach, describe, expect, it } from "vitest";

import {
  createDurableAdmissionFixture,
  SCOPE_A_TOKEN,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("S5 retention through the official MCP Client", () => {
  it("projects expired results without a cleanup tool while preserving bounded in-period reads", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const operationId = "s5-mcp-expired-submit";
    const instruction = "private terminal prompt";

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

    const submitted = structured(
      await client.callTool({
        name: "agentport_submit_task",
        arguments: { operationId, agentId: "agent-a", instruction },
      }),
    );
    expect(submitted).toMatchObject({ ok: true, replayed: false });
    const expiredTask = submitted.task as Record<string, unknown>;

    const live = structured(
      await client.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "s5-mcp-live-submit",
          agentId: "agent-a",
          instruction: "in-period bounded projection",
        },
      }),
    );
    const liveTask = live.task as Record<string, unknown>;

    const inPeriodGet = await client.callTool({
      name: "agentport_get_task",
      arguments: { taskId: liveTask.taskId },
    });
    expectStructuredTextAgreement(inPeriodGet);
    expect(structured(inPeriodGet)).toMatchObject({
      ok: true,
      task: {
        taskId: liveTask.taskId,
        instruction: "in-period bounded projection",
      },
    });

    const inPeriodList = await client.callTool({
      name: "agentport_list_tasks",
      arguments: { limit: 1 },
    });
    expectStructuredTextAgreement(inPeriodList);
    expect(structured(inPeriodList)).toMatchObject({ ok: true });
    const summaries = structured(inPeriodList).tasks;
    expect(Array.isArray(summaries)).toBe(true);
    if (!Array.isArray(summaries)) throw new Error("Expected Task summaries");
    expect(summaries).toHaveLength(1);
    expect(
      summaries.some(
        (summary) => isRecord(summary) && "instruction" in summary,
      ),
    ).toBe(false);

    const canceled = await client.callTool({
      name: "agentport_cancel_task",
      arguments: {
        operationId: "s5-mcp-expired-cancel",
        taskId: expiredTask.taskId,
      },
    });
    expectStructuredTextAgreement(canceled);
    expect(structured(canceled)).toMatchObject({
      ok: true,
      task: { taskId: expiredTask.taskId, state: "canceled" },
    });

    await expect(
      fixture.store.expireRetainedData({
        asOf: "2026-10-15T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ tasksExpired: 1, receiptsTombstoned: 2 });

    const expiredGet = await client.callTool({
      name: "agentport_get_task",
      arguments: { taskId: expiredTask.taskId },
    });
    expectStructuredTextAgreement(expiredGet);
    expect(expiredGet.isError).toBe(true);
    expect(structured(expiredGet)).toEqual({
      ok: false,
      error: {
        code: "result_expired",
        message: "The retained Task result has expired",
        retryable: false,
        safeRetry: "none",
      },
    });

    const expiredRetry = await client.callTool({
      name: "agentport_submit_task",
      arguments: { operationId, agentId: "agent-a", instruction },
    });
    expectStructuredTextAgreement(expiredRetry);
    expect(expiredRetry.isError).toBe(true);
    expect(structured(expiredRetry)).toEqual({
      ok: false,
      error: {
        code: "result_expired",
        message: "The retained Task result has expired",
        retryable: false,
        safeRetry: "none",
      },
    });

    const afterExpiryList = await client.callTool({
      name: "agentport_list_tasks",
      arguments: { limit: 10 },
    });
    expectStructuredTextAgreement(afterExpiryList);
    expect(structured(afterExpiryList)).toMatchObject({
      ok: true,
      tasks: [{ taskId: liveTask.taskId }],
    });
    expect(structured(afterExpiryList).tasks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: expiredTask.taskId }),
      ]),
    );
  });
});
