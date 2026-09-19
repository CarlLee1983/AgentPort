import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type {
  AuthInfo,
  McpHandlerRequestOptions,
  McpHttpHandler,
} from "@modelcontextprotocol/server";

import { createDurableAdmissionMcpHandler } from "../../src/mcp/adapter.js";
import { MCP_PROTOCOL_VERSION } from "../../src/mcp/protocol.js";
import { startLoopbackDurableAdmissionServer } from "../../src/mcp/loopback-server.js";
import type { DurableAdmissionFixture } from "./durable-admission.js";

export interface McpTranscriptEntry {
  method: string;
  principalId: string;
  protocolVersion?: unknown;
  clientInfo?: unknown;
  clientCapabilities?: unknown;
}

export interface DurableAdmissionMcpEndpoint {
  url: URL;
  transcript: McpTranscriptEntry[];
  flushAudit(): Promise<void>;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestEntry(
  request: Request,
  authInfo: AuthInfo | undefined,
  parsedBody: unknown,
): Promise<McpTranscriptEntry | undefined> {
  let body = parsedBody;
  if (body === undefined) {
    try {
      body = await request.clone().json();
    } catch {
      return undefined;
    }
  }
  if (
    !isRecord(body) ||
    typeof body.method !== "string" ||
    authInfo === undefined
  ) {
    return undefined;
  }
  const params = isRecord(body.params) ? body.params : {};
  const meta = isRecord(params._meta) ? params._meta : {};
  return {
    method: body.method,
    principalId: authInfo.clientId,
    protocolVersion: meta["io.modelcontextprotocol/protocolVersion"],
    clientInfo: meta["io.modelcontextprotocol/clientInfo"],
    clientCapabilities: meta["io.modelcontextprotocol/clientCapabilities"],
  };
}

export async function startDurableAdmissionMcpEndpoint(
  fixture: DurableAdmissionFixture,
  options: {
    dispatch?: (taskId: string) => Promise<unknown>;
    canSubmitTask?: () => boolean;
    canDispatchTask?: () => boolean;
  } = {},
): Promise<DurableAdmissionMcpEndpoint> {
  const transcript: McpTranscriptEntry[] = [];
  const handler = createDurableAdmissionMcpHandler(fixture.service, options);
  const tracedHandler: McpHttpHandler = {
    ...handler,
    fetch: async (
      request: Request,
      options?: McpHandlerRequestOptions,
    ): Promise<Response> => {
      const entry = await requestEntry(
        request,
        options?.authInfo,
        options?.parsedBody,
      );
      const response = await handler.fetch(request, options);
      if (entry !== undefined) transcript.push(entry);
      return response;
    },
  };
  const server = await startLoopbackDurableAdmissionServer({
    registry: fixture.registry,
    handler: tracedHandler,
    auditRecorder: fixture.store,
  });
  return {
    url: server.url,
    transcript,
    flushAudit: () => server.flushAudit(),
    close: async () => {
      try {
        await server.close();
      } finally {
        await handler.close();
      }
    },
  };
}

export function createDurableAdmissionClient(url: URL, token: string): Client {
  const client = new Client(
    { name: "ap002-client", version: "1.0.0" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
    },
  );
  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: { token: () => Promise.resolve(token) },
  });
  return Object.assign(client, { durableAdmissionTransport: transport });
}

export async function connectDurableAdmissionClient(
  url: URL,
  token: string,
): Promise<Client> {
  const client = createDurableAdmissionClient(url, token) as Client & {
    durableAdmissionTransport: StreamableHTTPClientTransport;
  };
  await client.connect(client.durableAdmissionTransport);
  return client;
}

export function expectStructuredTextAgreement(result: {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}): void {
  const first = result.content[0];
  if (first?.type !== "text" || first.text === undefined) {
    throw new Error("Expected JSON TextContent");
  }
  const parsed: unknown = JSON.parse(first.text);
  if (JSON.stringify(parsed) !== JSON.stringify(result.structuredContent)) {
    throw new Error("structuredContent and JSON TextContent differ");
  }
}
