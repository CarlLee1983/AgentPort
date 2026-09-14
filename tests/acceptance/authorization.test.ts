import { Client } from "@modelcontextprotocol/client";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MCP_PROTOCOL_VERSION } from "../../src/mcp/protocol.js";
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

const INSTRUCTION_SENTINEL = "AP002-INSTRUCTION-SENTINEL";
const PROTOCOL_SENTINEL = "SECRET-CREDENTIAL-SENTINEL";
const UNKNOWN_FIELD_SENTINEL = "SECRET-UNKNOWN-FIELD-SENTINEL";
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

function modernRequest(
  id: string,
  method: string,
  params: Record<string, unknown>,
  protocolVersion = MCP_PROTOCOL_VERSION,
): object {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": protocolVersion,
        "io.modelcontextprotocol/clientInfo": {
          name: "ap002-raw-client",
          version: "1.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

async function post(
  url: URL,
  token: string | undefined,
  body: object,
  protocolVersion = MCP_PROTOCOL_VERSION,
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
    "mcp-method":
      "method" in body && typeof body.method === "string" ? body.method : "",
    "mcp-protocol-version": protocolVersion,
  });
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  if (
    "params" in body &&
    typeof body.params === "object" &&
    body.params !== null &&
    "name" in body.params &&
    typeof body.params.name === "string"
  ) {
    headers.set("mcp-name", body.params.name);
  }
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}

function assertApplicationError(
  result: Awaited<ReturnType<Client["callTool"]>>,
  code: string,
): void {
  expect(result.isError).toBe(true);
  expectStructuredTextAgreement(result);
  expect(structured(result)).toMatchObject({
    ok: false,
    error: { code, retryable: false },
  });
}

describe("AP-002 authorization boundary", () => {
  it("returns HTTP 401 before protocol handling for missing or invalid credentials", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const output: string[] = [];
    const capture = ((chunk: string | Uint8Array): boolean => {
      output.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(capture);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(capture);
    try {
      const body = modernRequest("authorization", "tools/list", {});
      const [missing, invalid] = await Promise.all([
        post(endpoint.url, undefined, body),
        post(endpoint.url, INVALID_TOKEN, body),
      ]);
      expect([missing.status, invalid.status]).toEqual([401, 401]);
      const observed = `${await missing.text()}\n${await invalid.text()}\n${output.join("")}\n${JSON.stringify(endpoint.transcript)}`;
      expect(observed).not.toContain(INVALID_TOKEN);
      expect(observed).not.toContain(SCOPE_A_TOKEN);
      expect(observed).not.toContain(SCOPE_B_TOKEN);
      expect(endpoint.transcript).toHaveLength(0);
      const databaseBytes = Buffer.concat(
        await Promise.all(
          [
            fixture.databasePath,
            `${fixture.databasePath}-wal`,
            `${fixture.databasePath}-shm`,
          ].map(async (path) => readFile(path).catch(() => Buffer.alloc(0))),
        ),
      );
      for (const token of [INVALID_TOKEN, SCOPE_A_TOKEN, SCOPE_B_TOKEN]) {
        expect(databaseBytes.includes(Buffer.from(token))).toBe(false);
      }
      const verification = await readFile(
        resolve(
          import.meta.dirname,
          "../../specs/stories/AP-002-platform-neutral-durable-admission/verification.md",
        ),
        "utf8",
      );
      expect(verification).not.toContain(INSTRUCTION_SENTINEL);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("rejects unsupported protocol metadata before any application operation", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const response = await post(
      endpoint.url,
      SCOPE_A_TOKEN,
      modernRequest(
        "old-version",
        "tools/call",
        {
          name: "agentport_submit_task",
          arguments: {
            operationId: "must-not-run",
            agentId: "agent-a",
            instruction: "must not persist",
          },
        },
        PROTOCOL_SENTINEL,
      ),
      PROTOCOL_SENTINEL,
    );
    expect(response.status).toBe(400);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toMatchObject({
      error: {
        code: -32_022,
        message: "Unsupported or missing protocol version",
      },
    });
    expect(responseText).not.toContain(PROTOCOL_SENTINEL);
    expect(
      await fixture.service.listTasks({ principalId: "principal-a" }, {}),
    ).toMatchObject({ tasks: [] });
  });

  it("sanitizes mismatched protocol metadata and unknown tool names", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const mismatch = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SCOPE_A_TOKEN}`,
        "content-type": "application/json",
        "mcp-method": "initialize",
        "mcp-protocol-version": PROTOCOL_SENTINEL,
      },
      body: JSON.stringify(
        modernRequest("mismatch", "tools/list", {}, PROTOCOL_SENTINEL),
      ),
    });
    const mismatchText = await mismatch.text();
    expect(mismatch.status).toBe(400);
    expect(mismatchText).not.toContain(PROTOCOL_SENTINEL);

    const unknownMethod = await post(
      endpoint.url,
      SCOPE_A_TOKEN,
      modernRequest("unknown-method", PROTOCOL_SENTINEL, {}),
    );
    const unknownMethodText = await unknownMethod.text();
    expect(unknownMethod.status).toBe(200);
    expect(JSON.parse(unknownMethodText)).toMatchObject({
      error: { code: -32_601, message: "Method not found" },
    });
    expect(unknownMethodText).not.toContain(PROTOCOL_SENTINEL);

    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    let unknownError: unknown;
    try {
      await client.callTool({ name: PROTOCOL_SENTINEL, arguments: {} });
    } catch (error) {
      unknownError = error;
    }
    expect(unknownError).toMatchObject({ code: -32_602 });
    expect(String(unknownError)).not.toContain(PROTOCOL_SENTINEL);
  });

  it("rejects a missing protocol header and incomplete per-request envelope", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const withoutHeader = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SCOPE_A_TOKEN}`,
        "content-type": "application/json",
        "mcp-method": "tools/list",
      },
      body: JSON.stringify(modernRequest("missing-header", "tools/list", {})),
    });
    const incomplete = await post(endpoint.url, SCOPE_A_TOKEN, {
      jsonrpc: "2.0",
      id: "incomplete-envelope",
      method: "tools/list",
      params: {},
    });
    expect([withoutHeader.status, incomplete.status]).toEqual([400, 400]);
    expect(endpoint.transcript).toHaveLength(0);
    expect(
      await fixture.service.listTasks({ principalId: "principal-a" }, {}),
    ).toMatchObject({ tasks: [] });
  });

  it("rejects an HTTP body over 128 KiB before Task admission", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const response = await post(
      endpoint.url,
      SCOPE_A_TOKEN,
      modernRequest("oversized", "tools/call", {
        name: "agentport_submit_task",
        arguments: {
          operationId: "oversized-body",
          agentId: "agent-a",
          instruction: "x".repeat(129 * 1024),
        },
      }),
    );
    expect(response.status).toBe(413);
    expect(
      await fixture.service.listTasks({ principalId: "principal-a" }, {}),
    ).toMatchObject({ tasks: [] });
  });

  it("projects full membership revocation as access_denied for all six tools", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const submitted = await client.callTool({
      name: "agentport_submit_task",
      arguments: {
        operationId: "before-revocation",
        agentId: "agent-a",
        instruction: "existing Task",
      },
    });
    const task = structured(submitted).task as Record<string, unknown>;
    await fixture.registry.replace({
      ...fixture.registryConfiguration,
      principals: fixture.registryConfiguration.principals.map((principal) =>
        principal.principalId === "principal-a"
          ? { ...principal, active: false }
          : principal,
      ),
    });

    const results = await Promise.all([
      client.callTool({ name: "agentport_list_agents", arguments: {} }),
      client.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "after-revocation",
          agentId: "agent-a",
          instruction: "must not persist",
        },
      }),
      client.callTool({
        name: "agentport_get_task",
        arguments: { taskId: task.taskId },
      }),
      client.callTool({ name: "agentport_list_tasks", arguments: {} }),
      client.callTool({ name: "agentport_get_events", arguments: {} }),
      client.callTool({
        name: "agentport_cancel_task",
        arguments: { operationId: "cancel-revoked", taskId: task.taskId },
      }),
    ]);
    for (const result of results) {
      assertApplicationError(result, "access_denied");
      expect(JSON.stringify(result)).not.toMatch(/membership|revoked/i);
    }
  });

  it("sanitizes an unexpected adapter failure", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    vi.spyOn(fixture.service, "listAgents").mockRejectedValue(
      new Error(`unexpected ${SCOPE_A_TOKEN} /tmp/private-workspace`),
    );
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const result = await client.callTool({
      name: "agentport_list_agents",
      arguments: {},
    });
    expect(structured(result)).toMatchObject({
      ok: false,
      error: {
        code: "internal_error",
        retryable: false,
        safeRetry: "none",
      },
    });
    expect(JSON.stringify(result)).not.toContain(SCOPE_A_TOKEN);
    expect(JSON.stringify(result)).not.toContain("/tmp/private-workspace");
  });

  it("conceals cross-scope identities and filters a revoked Agent from list surfaces", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const clientA = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const clientB = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_B_TOKEN),
    );
    const revokable = await clientA.callTool({
      name: "agentport_submit_task",
      arguments: {
        operationId: "revokable-task",
        agentId: "agent-revokable",
        instruction: INSTRUCTION_SENTINEL,
      },
    });
    const retained = await clientA.callTool({
      name: "agentport_submit_task",
      arguments: {
        operationId: "retained-task",
        agentId: "agent-a",
        instruction: "retained",
      },
    });
    const otherScope = await clientB.callTool({
      name: "agentport_submit_task",
      arguments: {
        operationId: "scope-b-task",
        agentId: "agent-b",
        instruction: "scope b",
      },
    });
    await clientB.callTool({
      name: "agentport_submit_task",
      arguments: {
        operationId: "scope-b-task-2",
        agentId: "agent-b",
        instruction: "scope b page two",
      },
    });
    const bPage = await clientB.callTool({
      name: "agentport_list_tasks",
      arguments: { limit: 1 },
    });
    const scopeBCursor = structured(bPage).nextCursor;
    const otherTask = structured(otherScope).task as Record<string, unknown>;
    const revokableTask = structured(revokable).task as Record<string, unknown>;
    const retainedTask = structured(retained).task as Record<string, unknown>;

    for (const result of await Promise.all([
      clientA.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "cross-agent",
          agentId: "agent-b",
          instruction: "must fail",
        },
      }),
      clientA.callTool({
        name: "agentport_get_task",
        arguments: { taskId: otherTask.taskId },
      }),
      clientA.callTool({
        name: "agentport_cancel_task",
        arguments: { operationId: "cross-cancel", taskId: otherTask.taskId },
      }),
      clientA.callTool({
        name: "agentport_list_tasks",
        arguments: { agentId: "agent-b" },
      }),
      clientA.callTool({
        name: "agentport_list_tasks",
        arguments: { cursor: scopeBCursor },
      }),
    ])) {
      assertApplicationError(result, "not_found");
    }

    const principalA = fixture.registryConfiguration.principals.find(
      ({ principalId }) => principalId === "principal-a",
    );
    if (principalA === undefined) throw new Error("Missing fixture Principal");
    await fixture.registry.replace({
      ...fixture.registryConfiguration,
      principals: [
        { ...principalA, allowedAgentIds: ["agent-a"] },
        ...fixture.registryConfiguration.principals.filter(
          ({ principalId }) => principalId !== "principal-a",
        ),
      ],
    });

    const [agents, tasks, events] = await Promise.all([
      clientA.callTool({ name: "agentport_list_agents", arguments: {} }),
      clientA.callTool({ name: "agentport_list_tasks", arguments: {} }),
      clientA.callTool({ name: "agentport_get_events", arguments: {} }),
    ]);
    expect(structured(agents).agents).toMatchObject([{ agentId: "agent-a" }]);
    expect(structured(tasks).tasks).toMatchObject([
      { taskId: retainedTask.taskId, agentId: "agent-a" },
    ]);
    expect(structured(events).events).toMatchObject([
      { taskId: retainedTask.taskId, agentId: "agent-a" },
    ]);
    const sanitizedLists = `${JSON.stringify(structured(tasks))}\n${JSON.stringify(structured(events))}\n${JSON.stringify(endpoint.transcript)}`;
    expect(sanitizedLists).not.toContain(INSTRUCTION_SENTINEL);
    expect(sanitizedLists).not.toContain(SCOPE_A_TOKEN);

    for (const result of await Promise.all([
      clientA.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "revoked-agent-submit",
          agentId: "agent-revokable",
          instruction: "must fail",
        },
      }),
      clientA.callTool({
        name: "agentport_get_task",
        arguments: { taskId: revokableTask.taskId },
      }),
      clientA.callTool({
        name: "agentport_cancel_task",
        arguments: {
          operationId: "revoked-agent-cancel",
          taskId: revokableTask.taskId,
        },
      }),
      clientA.callTool({
        name: "agentport_list_tasks",
        arguments: { agentId: "agent-revokable" },
      }),
      clientA.callTool({
        name: "agentport_get_events",
        arguments: { taskId: revokableTask.taskId },
      }),
    ])) {
      assertApplicationError(result, "not_found");
    }
  });

  it("rejects unauthorized Context IDs and every caller-controlled identity or execution override", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const overrides: Array<{
      value: Record<string, unknown>;
      expectedCode: "not_found" | "validation_error";
    }> = [
      {
        value: { contextId: "context-existing-in-scope" },
        expectedCode: "not_found",
      },
      {
        value: { principalId: "principal-b" },
        expectedCode: "validation_error",
      },
      { value: { accessScopeId: "scope-b" }, expectedCode: "validation_error" },
      {
        value: { workspacePath: "/tmp/ap002-outside-workspace" },
        expectedCode: "validation_error",
      },
      {
        value: { runtimeBinary: "/tmp/ap002-runtime" },
        expectedCode: "validation_error",
      },
      {
        value: { driverOptions: { unsafe: true } },
        expectedCode: "validation_error",
      },
      {
        value: { policy: { allowAll: true } },
        expectedCode: "validation_error",
      },
      {
        value: { [UNKNOWN_FIELD_SENTINEL]: true },
        expectedCode: "validation_error",
      },
    ];
    for (const [index, override] of overrides.entries()) {
      const response = await client.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: `override-${String(index)}`,
          agentId: "agent-a",
          instruction: "must not persist",
          ...override.value,
        },
      });
      assertApplicationError(response, override.expectedCode);
      const rendered = JSON.stringify(response);
      expect(rendered).not.toContain(SCOPE_A_TOKEN);
      expect(rendered).not.toContain("/tmp/ap002-outside-workspace");
      expect(rendered).not.toContain("/tmp/ap002-runtime");
      expect(rendered).not.toContain(UNKNOWN_FIELD_SENTINEL);
    }
    expect(
      await fixture.service.listTasks({ principalId: "principal-a" }, {}),
    ).toMatchObject({ tasks: [] });
  });
});
