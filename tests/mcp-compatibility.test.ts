import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  MCP_PROTOCOL_VERSION,
  startMcpCompatibilityFixture,
  type McpCompatibilityFixture,
} from "../compatibility/mcp-fixture.js";

const PRINCIPAL_A_TOKEN = "ap001-principal-a-token";
const PRINCIPAL_B_TOKEN = "ap001-principal-b-token";
const INVALID_TOKEN = "ap001-invalid-token";

function createClient(url: URL, token: string): Client {
  const client = new Client(
    { name: "ap001-client", version: "1.0.0" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
    },
  );

  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: { token: () => Promise.resolve(token) },
  });

  return Object.assign(client, { compatibilityTransport: transport });
}

async function connectClient(url: URL, token: string): Promise<Client> {
  const client = createClient(url, token) as Client & {
    compatibilityTransport: StreamableHTTPClientTransport;
  };
  await client.connect(client.compatibilityTransport);
  return client;
}

function modernRequest(
  id: string,
  method: string,
  params: Record<string, unknown>,
): object {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": {
          name: "ap001-raw-client",
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
  protocolVersion: string | null = MCP_PROTOCOL_VERSION,
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  if (protocolVersion !== null)
    headers.set("mcp-protocol-version", protocolVersion);
  if ("method" in body && typeof body.method === "string") {
    headers.set("mcp-method", body.method);
  }
  if (
    "method" in body &&
    body.method === "tools/call" &&
    "params" in body &&
    isRecord(body.params) &&
    typeof body.params.name === "string"
  ) {
    headers.set("mcp-name", body.params.name);
  }

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function captureProcessOutput<T>(action: () => Promise<T>): Promise<{
  output: string;
  value: T;
}> {
  const output: string[] = [];
  const capture = ((chunk: string | Uint8Array): boolean => {
    output.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(capture);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(capture);

  try {
    return { output: output.join(""), value: await action() };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe("AP-001 MCP compatibility fixture", () => {
  let fixture: McpCompatibilityFixture;

  beforeAll(async () => {
    fixture = await startMcpCompatibilityFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("uses the official pinned modern client for tools/list and tools/call", async () => {
    const clientA = await connectClient(fixture.url, PRINCIPAL_A_TOKEN);
    const list = await clientA.listTools();

    expect(list.tools).toHaveLength(1);
    expect(list.tools[0]).toMatchObject({
      name: "compatibility_identity",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object" },
    });

    const resultA = await clientA.callTool({
      name: "compatibility_identity",
      arguments: {},
    });
    expect(resultA.isError).not.toBe(true);
    expect(resultA.structuredContent).toEqual({
      ok: true,
      principal: "principal-a",
    });
    expect(
      JSON.parse(
        resultA.content[0]?.type === "text" ? resultA.content[0].text : "null",
      ),
    ).toEqual(resultA.structuredContent);

    const clientB = await connectClient(fixture.url, PRINCIPAL_B_TOKEN);
    const resultB = await clientB.callTool({
      name: "compatibility_identity",
      arguments: {},
    });
    expect(resultB.structuredContent).toEqual({
      ok: true,
      principal: "principal-b",
    });

    const toolRequests = fixture.transcript.filter(({ method }) =>
      method.startsWith("tools/"),
    );
    expect(toolRequests.map(({ method }) => method)).toEqual([
      "tools/list",
      "tools/call",
      "tools/call",
    ]);
    for (const request of toolRequests) {
      expect(request).toMatchObject({
        protocolVersion: MCP_PROTOCOL_VERSION,
        clientInfo: { name: "ap001-client", version: "1.0.0" },
        clientCapabilities: {},
      });
    }

    await Promise.all([clientA.close(), clientB.close()]);
  });

  it("rejects unknown tools and invalid arguments without execution", async () => {
    const client = await connectClient(fixture.url, PRINCIPAL_A_TOKEN);
    const before = fixture.executionCount();

    await expect(
      client.callTool({ name: "ap001-unknown-tool", arguments: {} }),
    ).rejects.toMatchObject({ code: -32602 });

    const invalid = await client.callTool({
      name: "compatibility_identity",
      arguments: { unexpected: true },
    });
    expect(invalid.isError).toBe(true);

    const identityOverride = await client.callTool({
      name: "compatibility_identity",
      arguments: { principal: "principal-b" },
    });
    expect(identityOverride.isError).toBe(true);
    expect(fixture.executionCount()).toBe(before);
    await client.close();
  });

  it("rejects missing and invalid bearer credentials without disclosure", async () => {
    const body = modernRequest("ap001-request-auth", "tools/list", {});
    const before = fixture.executionCount();
    const captured = await captureProcessOutput(async () => {
      const [missing, invalid, missingEverything] = await Promise.all([
        post(fixture.url, undefined, body),
        post(fixture.url, INVALID_TOKEN, body),
        post(fixture.url, undefined, body, null),
      ]);
      return {
        invalid: await invalid.text(),
        missing: await missing.text(),
        missingEverything: {
          body: await missingEverything.text(),
          status: missingEverything.status,
        },
        statuses: [missing.status, invalid.status],
      };
    });

    expect(captured.value.statuses).toEqual([401, 401]);
    expect(captured.value.missingEverything.status).toBe(401);
    const output = `${captured.output}\n${JSON.stringify(captured.value)}\n${JSON.stringify(fixture.transcript)}`;
    expect(output).not.toContain(INVALID_TOKEN);
    expect(output).not.toContain(PRINCIPAL_A_TOKEN);
    expect(output).not.toContain(PRINCIPAL_B_TOKEN);
    expect(fixture.executionCount()).toBe(before);
  });

  it("rejects unsupported, incomplete, and legacy protocol requests", async () => {
    const before = fixture.executionCount();
    const unsupportedBody = modernRequest("ap001-request-1", "tools/call", {
      name: "compatibility_identity",
      arguments: {},
    }) as { params: { _meta: Record<string, unknown> } };
    unsupportedBody.params._meta["io.modelcontextprotocol/protocolVersion"] =
      "1900-01-01";

    const unsupported = await post(
      fixture.url,
      PRINCIPAL_A_TOKEN,
      unsupportedBody,
      "1900-01-01",
    );
    expect(unsupported.status).toBe(400);
    expect(JSON.parse(await unsupported.text())).toMatchObject({
      error: {
        code: -32022,
        data: { requested: "1900-01-01", supported: [MCP_PROTOCOL_VERSION] },
      },
      id: "ap001-request-1",
    });

    const missingHeader = await post(
      fixture.url,
      PRINCIPAL_A_TOKEN,
      modernRequest("ap001-request-missing-header", "tools/list", {}),
      null,
    );
    expect(missingHeader.status).toBe(400);

    const incomplete = await post(fixture.url, PRINCIPAL_A_TOKEN, {
      jsonrpc: "2.0",
      id: "ap001-request-incomplete",
      method: "tools/list",
      params: {},
    });
    expect(incomplete.status).toBe(400);

    const legacy = await post(
      fixture.url,
      PRINCIPAL_A_TOKEN,
      {
        jsonrpc: "2.0",
        id: "ap001-request-legacy",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          clientInfo: { name: "legacy", version: "1.0.0" },
          capabilities: {},
        },
      },
      null,
    );
    expect(legacy.status).toBe(400);
    expect(JSON.parse(await legacy.text())).toMatchObject({
      error: {
        code: -32022,
        data: { requested: "2025-11-25", supported: [MCP_PROTOCOL_VERSION] },
      },
    });

    const initialized = await post(
      fixture.url,
      PRINCIPAL_A_TOKEN,
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      },
      null,
    );
    expect(initialized.status).toBe(400);
    expect(JSON.parse(await initialized.text())).toMatchObject({
      error: {
        code: -32600,
        message: "Invalid Request: legacy lifecycle is not supported",
      },
    });
    expect(fixture.executionCount()).toBe(before);

    const stateless = await post(
      fixture.url,
      PRINCIPAL_A_TOKEN,
      modernRequest("ap001-request-stateless", "tools/list", {}),
    );
    expect(stateless.status).toBe(200);
    expect(stateless.headers.get("mcp-session-id")).toBeNull();
  });
});
