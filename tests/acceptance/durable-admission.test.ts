import { rm } from "node:fs/promises";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DurableAgentExecutionService } from "../../src/core/agent-execution-service.js";
import { AgentRegistry } from "../../src/bootstrap/registry.js";
import { createDurableAdmissionMcpHandler } from "../../src/mcp/adapter.js";
import { MCP_PROTOCOL_VERSION } from "../../src/mcp/protocol.js";
import { startLoopbackDurableAdmissionServer } from "../../src/mcp/loopback-server.js";
import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";
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

describe("AP-002 durable admission through the official MCP Client", () => {
  it("publishes the registered durable tools with identical structured and JSON text results", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );

    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name).sort()).toEqual([
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
    for (const tool of tools.tools) {
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(tool.outputSchema).toMatchObject({ type: "object" });
    }

    const agents = await client.callTool({
      name: "agentport_list_agents",
      arguments: {},
    });
    expectStructuredTextAgreement(agents);
    expect(structured(agents)).toMatchObject({
      ok: true,
      agents: [{ agentId: "agent-a" }, { agentId: "agent-revokable" }],
    });

    const submitted = await client.callTool({
      name: "agentport_submit_task",
      arguments: {
        operationId: "ap002-operation-1",
        agentId: "agent-a",
        instruction: "Persist this task without dispatch",
        executionLimitSeconds: 600,
        inputWaitSeconds: 3_600,
      },
    });
    expectStructuredTextAgreement(submitted);
    expect(submitted.isError).not.toBe(true);
    const task = structured(submitted).task as Record<string, unknown>;
    expect(task).toMatchObject({
      state: "queued",
      revision: 1,
      instruction: "Persist this task without dispatch",
      observationStatus: "current",
    });

    const calls = await Promise.all([
      client.callTool({
        name: "agentport_get_task",
        arguments: { taskId: task.taskId },
      }),
      client.callTool({ name: "agentport_list_tasks", arguments: {} }),
      client.callTool({
        name: "agentport_get_events",
        arguments: { taskId: task.taskId },
      }),
    ]);
    for (const call of calls) expectStructuredTextAgreement(call);
    expect(structured(calls[0]).task).toMatchObject({
      taskId: task.taskId,
      state: "queued",
    });
    expect(structured(calls[1]).tasks).toMatchObject([
      { taskId: task.taskId, state: "queued" },
    ]);
    const taskSummaries = structured(calls[1]).tasks;
    expect(Array.isArray(taskSummaries)).toBe(true);
    if (!Array.isArray(taskSummaries))
      throw new Error("Expected Task summaries");
    expect(
      taskSummaries.some(
        (summary) => isRecord(summary) && "instruction" in summary,
      ),
    ).toBe(false);
    expect(structured(calls[2]).events).toMatchObject([
      { taskId: task.taskId, type: "accepted" },
    ]);

    const canceled = await client.callTool({
      name: "agentport_cancel_task",
      arguments: { operationId: "cancel-queued", taskId: task.taskId },
    });
    expectStructuredTextAgreement(canceled);
    expect(structured(canceled).task).toMatchObject({
      taskId: task.taskId,
      state: "canceled",
      revision: 2,
    });

    expect(
      endpoint.transcript.filter(({ method }) => method.startsWith("tools/")),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          protocolVersion: MCP_PROTOCOL_VERSION,
          clientInfo: { name: "ap002-client", version: "1.0.0" },
          clientCapabilities: {},
          principalId: "principal-a",
        }),
      ]),
    );
  });

  it("schedules a queued Task only after the durable admission succeeds", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const dispatch = vi.fn(() => Promise.resolve({ kind: "started" }));
    const endpoint = track(
      await startDurableAdmissionMcpEndpoint(fixture, { dispatch }),
    );
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const submitted = await client.callTool({
      name: "agentport_submit_task",
      arguments: {
        operationId: "ap002-dispatch-after-admission",
        agentId: "agent-a",
        instruction: "schedule after commit",
      },
    });
    const task = structured(submitted).task as Record<string, unknown>;
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(task.taskId);
    });
  });

  it("does not dispatch a resumed Task while Runtime dispatch is fenced", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const dispatch = vi.fn(() => Promise.resolve({ kind: "started" }));
    const endpoint = track(
      await startDurableAdmissionMcpEndpoint(fixture, {
        dispatch,
        canDispatchTask: () => false,
      }),
    );
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const predecessor = await fixture.service.submitTask(
      { principalId: "principal-a" },
      {
        operationId: "ap002-fenced-resume-predecessor",
        agentId: "agent-a",
        instruction: "cancel before the follow-up",
      },
    );
    const successor = await fixture.service.submitTask(
      { principalId: "principal-a" },
      {
        operationId: "ap002-fenced-resume-successor",
        agentId: "agent-a",
        contextId: predecessor.task.contextId,
        instruction: "resume only after readiness",
      },
    );
    await fixture.service.cancelTask(
      { principalId: "principal-a" },
      {
        operationId: "ap002-fenced-resume-cancel",
        taskId: predecessor.task.taskId,
      },
    );
    const blocked = await fixture.service.getTask(
      { principalId: "principal-a" },
      { taskId: successor.task.taskId },
    );
    const resumed = await client.callTool({
      name: "agentport_resume_context",
      arguments: {
        operationId: "ap002-fenced-resume",
        contextId: predecessor.task.contextId,
        expectedRevision: blocked.contextRevision,
        continuationMode: "fresh_session",
        contextSummary: "resume after the canceled predecessor",
      },
    });
    expect(structured(resumed)).toMatchObject({
      ok: true,
      task: { taskId: successor.task.taskId, state: "queued" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("recovers the original Task after a transport response is discarded", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const operationId = "discarded-transport-response";
    const instruction = "commit before the response is observed";
    const discarded = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SCOPE_A_TOKEN}`,
        "content-type": "application/json",
        "mcp-method": "tools/call",
        "mcp-name": "agentport_submit_task",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "discard-me",
        method: "tools/call",
        params: {
          name: "agentport_submit_task",
          arguments: { operationId, agentId: "agent-a", instruction },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": {
              name: "ap002-loss-fixture",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    expect(discarded.status).toBe(200);
    await discarded.body?.cancel();

    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const replay = await client.callTool({
      name: "agentport_submit_task",
      arguments: { operationId, agentId: "agent-a", instruction },
    });
    expect(structured(replay)).toMatchObject({
      ok: true,
      replayed: true,
      task: { state: "queued", instruction },
    });
    expect(
      (await fixture.service.listTasks({ principalId: "principal-a" }, {}))
        .tasks,
    ).toHaveLength(1);
    const conflict = await client.callTool({
      name: "agentport_submit_task",
      arguments: {
        operationId,
        agentId: "agent-a",
        instruction: "different fingerprint",
      },
    });
    expect(structured(conflict)).toMatchObject({
      ok: false,
      error: { code: "operation_conflict", safeRetry: "none" },
      task: { instruction, state: "queued" },
    });
  });

  it("marks a timed-out mutation retryable only with the same operationId", async () => {
    const fixture = track(
      await createDurableAdmissionFixture({ requestTimeoutMs: 500 }),
    );
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const operationId = "mutation-timeout";
    const blocking = fixture.store.probe("block", 1_500).catch(() => undefined);
    const timedOut = await client.callTool({
      name: "agentport_submit_task",
      arguments: {
        operationId,
        agentId: "agent-a",
        instruction: "retry safely after worker delay",
      },
    });
    expect(structured(timedOut)).toMatchObject({
      ok: false,
      error: {
        code: "storage_unavailable",
        retryable: true,
        safeRetry: "same_operation_id",
      },
    });
    await blocking;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const replay = await client.callTool({
      name: "agentport_submit_task",
      arguments: {
        operationId,
        agentId: "agent-a",
        instruction: "retry safely after worker delay",
      },
    });
    expect(structured(replay)).toMatchObject({ ok: true, replayed: true });
    expect(
      (await fixture.service.listTasks({ principalId: "principal-a" }, {}))
        .tasks,
    ).toHaveLength(1);
  });

  it("cancels a restart-paused Task under its stable identity", async () => {
    const fixture = await createDurableAdmissionFixture();
    const firstEndpoint = await startDurableAdmissionMcpEndpoint(fixture);
    const firstClient = await connectDurableAdmissionClient(
      firstEndpoint.url,
      SCOPE_A_TOKEN,
    );
    const submitted = await firstClient.callTool({
      name: "agentport_submit_task",
      arguments: {
        operationId: "submit-before-restart",
        agentId: "agent-a",
        instruction: "Remain durable across restart",
      },
    });
    const originalTask = structured(submitted).task as Record<string, unknown>;
    await firstClient.callTool({
      name: "agentport_submit_task",
      arguments: {
        operationId: "submit-before-restart-2",
        agentId: "agent-a",
        instruction: "Remain on the next Task page",
      },
    });
    const taskPage = await firstClient.callTool({
      name: "agentport_list_tasks",
      arguments: { limit: 1 },
    });
    const eventPage = await firstClient.callTool({
      name: "agentport_get_events",
      arguments: { limit: 1 },
    });
    const taskCursor = structured(taskPage).nextCursor;
    const eventCursor = structured(eventPage).nextCursor;
    await firstClient.close();
    await firstEndpoint.close();
    await fixture.store.close();

    resources.push(() =>
      rm(fixture.directory, { force: true, recursive: true }),
    );
    const restartedStore = track(
      await SqliteDurableAdmissionStore.open({
        databasePath: fixture.databasePath,
      }),
    );
    const restartedRegistry = await AgentRegistry.create(
      fixture.registryConfiguration,
      restartedStore,
    );
    const restartedService = new DurableAgentExecutionService(
      restartedRegistry,
      restartedStore,
      { cursorSecret: "ap002-fixture-cursor-secret" },
    );
    const restartedHandler = createDurableAdmissionMcpHandler(restartedService);
    resources.push(() => restartedHandler.close());
    const restartedServer = track(
      await startLoopbackDurableAdmissionServer({
        registry: restartedRegistry,
        handler: restartedHandler,
        auditRecorder: restartedStore,
      }),
    );
    const restartedClient = new Client(
      { name: "ap002-client", version: "1.0.0" },
      {
        capabilities: {},
        versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
      },
    );
    await restartedService.initializeAfterRestart();
    const restartedTransport = new StreamableHTTPClientTransport(
      restartedServer.url,
      { authProvider: { token: () => Promise.resolve(SCOPE_A_TOKEN) } },
    );
    await restartedClient.connect(restartedTransport);
    track(restartedClient);

    const afterRestart = await restartedClient.callTool({
      name: "agentport_get_task",
      arguments: { taskId: originalTask.taskId },
    });
    expect(structured(afterRestart).task).toMatchObject({
      taskId: originalTask.taskId,
      state: "paused",
      revision: 2,
    });
    const nextTasks = await restartedClient.callTool({
      name: "agentport_list_tasks",
      arguments: { cursor: taskCursor, limit: 10 },
    });
    expect(structured(nextTasks).tasks).toHaveLength(1);
    const nextEvents = await restartedClient.callTool({
      name: "agentport_get_events",
      arguments: { afterCursor: eventCursor, limit: 10 },
    });
    expect(structured(nextEvents).events).toMatchObject([
      { type: "accepted" },
      { type: "daemon_restart_paused" },
      { type: "daemon_restart_paused" },
    ]);
    const canceled = await restartedClient.callTool({
      name: "agentport_cancel_task",
      arguments: {
        operationId: "cancel-after-restart",
        taskId: originalTask.taskId,
      },
    });
    expect(structured(canceled).task).toMatchObject({
      taskId: originalTask.taskId,
      state: "canceled",
      revision: 3,
    });
  });

  it("returns stable application errors for policy and schema bounds", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );

    for (const argumentsValue of [
      {
        operationId: "limit-execution",
        agentId: "agent-a",
        instruction: "too long",
        executionLimitSeconds: 999_999_999,
      },
      {
        operationId: "limit-input",
        agentId: "agent-a",
        instruction: "too long",
        inputWaitSeconds: 999_999_999,
      },
    ]) {
      const response = await client.callTool({
        name: "agentport_submit_task",
        arguments: argumentsValue,
      });
      expect(response.isError).toBe(true);
      expectStructuredTextAgreement(response);
      expect(structured(response)).toMatchObject({
        ok: false,
        error: { code: "validation_error", retryable: false },
      });
    }

    const invalidState = await client.callTool({
      name: "agentport_list_tasks",
      arguments: { state: "not-a-state" },
    });
    const invalidLimit = await client.callTool({
      name: "agentport_list_agents",
      arguments: { limit: 1_000_000 },
    });
    const oversizedUtf8 = await client.callTool({
      name: "agentport_submit_task",
      arguments: {
        operationId: "utf8-byte-limit",
        agentId: "agent-a",
        instruction: "界".repeat(22_000),
      },
    });
    for (const invalid of [invalidState, invalidLimit, oversizedUtf8]) {
      expect(invalid.isError).toBe(true);
      expectStructuredTextAgreement(invalid);
      expect(structured(invalid)).toMatchObject({
        ok: false,
        error: {
          code: "validation_error",
          retryable: false,
          safeRetry: "none",
        },
      });
    }
  });
});
