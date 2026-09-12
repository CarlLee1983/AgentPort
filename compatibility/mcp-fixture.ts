import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  McpServer,
  createMcpHandler,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { z } from "zod";

export const MCP_PROTOCOL_VERSION = "2026-07-28";

const PRINCIPALS = new Map([
  ["ap001-principal-a-token", "principal-a"],
  ["ap001-principal-b-token", "principal-b"],
]);

type AuthenticatedRequest = IncomingMessage & { auth?: AuthInfo };

export interface CompatibilityTranscriptEntry {
  requestId: number | string | null;
  method: string;
  principal: string;
  protocolVersion?: unknown;
  clientInfo?: unknown;
  clientCapabilities?: unknown;
}

export interface McpCompatibilityFixture {
  url: URL;
  transcript: CompatibilityTranscriptEntry[];
  executionCount(): number;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordRequest(
  transcript: CompatibilityTranscriptEntry[],
  body: unknown,
  authInfo: AuthInfo | undefined,
): void {
  if (!isRecord(body)) return;
  if (
    body.id !== undefined &&
    !(typeof body.id === "string" || typeof body.id === "number")
  )
    return;
  if (typeof body.method !== "string" || authInfo === undefined) return;

  const params = isRecord(body.params) ? body.params : {};
  const meta = isRecord(params._meta) ? params._meta : {};
  const entry: CompatibilityTranscriptEntry = {
    requestId: body.id ?? null,
    method: body.method,
    principal: authInfo.clientId,
  };

  const protocolVersion = meta["io.modelcontextprotocol/protocolVersion"];
  const clientInfo = meta["io.modelcontextprotocol/clientInfo"];
  const clientCapabilities = meta["io.modelcontextprotocol/clientCapabilities"];
  if (protocolVersion !== undefined) entry.protocolVersion = protocolVersion;
  if (clientInfo !== undefined) entry.clientInfo = clientInfo;
  if (clientCapabilities !== undefined)
    entry.clientCapabilities = clientCapabilities;
  transcript.push(entry);
}

function authenticate(req: IncomingMessage): AuthInfo | undefined {
  const authorization = req.headers.authorization;
  if (authorization === undefined || Array.isArray(authorization))
    return undefined;
  if (!authorization.startsWith("Bearer ")) return undefined;

  const token = authorization.slice("Bearer ".length);
  const principal = PRINCIPALS.get(token);
  if (principal === undefined) return undefined;

  return {
    token,
    clientId: principal,
    scopes: ["ap001:compatibility"],
  };
}

function rejectUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": "Bearer",
  });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

export async function startMcpCompatibilityFixture(): Promise<McpCompatibilityFixture> {
  const transcript: CompatibilityTranscriptEntry[] = [];
  let executions = 0;

  const handler = createMcpHandler(
    ({ authInfo }) => {
      const mcpServer = new McpServer(
        { name: "agentport-ap001-fixture", version: "1.0.0" },
        {
          capabilities: { tools: {} },
          supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
        },
      );

      mcpServer.registerTool(
        "compatibility_identity",
        {
          description:
            "Returns the synthetic principal established by the fixture bearer.",
          inputSchema: z.object({}).strict(),
          outputSchema: z.object({
            ok: z.literal(true),
            principal: z.enum(["principal-a", "principal-b"]),
          }),
        },
        () => {
          const principal = authInfo?.clientId;
          if (principal !== "principal-a" && principal !== "principal-b") {
            return {
              content: [{ type: "text", text: JSON.stringify({ ok: false }) }],
              isError: true,
            };
          }

          executions += 1;
          const result = { ok: true as const, principal };
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        },
      );

      return mcpServer;
    },
    {
      legacy: "reject",
    },
  );

  const tracedHandler = {
    fetch: async (
      request: Request,
      options?: { authInfo?: AuthInfo },
    ): Promise<Response> => {
      let body: unknown;
      try {
        body = await request.clone().json();
      } catch {
        body = undefined;
      }
      recordRequest(transcript, body, options?.authInfo);
      if (isRecord(body) && body.method === "notifications/initialized") {
        return Response.json(
          {
            jsonrpc: "2.0",
            error: {
              code: -32600,
              message: "Invalid Request: legacy lifecycle is not supported",
            },
            id: null,
          },
          { status: 400 },
        );
      }
      return handler.fetch(request, options);
    },
  };
  const serveMcp = toNodeHandler(tracedHandler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const httpServer = createServer((request, response) => {
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    if (!validateHost(request, response) || !validateOrigin(request, response))
      return;

    const authInfo = authenticate(request);
    if (authInfo === undefined) {
      rejectUnauthorized(response);
      return;
    }

    const declaredMethod = request.headers["mcp-method"];
    const isLegacyLifecycle =
      declaredMethod === "initialize" ||
      declaredMethod === "notifications/initialized";
    if (
      request.method === "POST" &&
      !isLegacyLifecycle &&
      (typeof request.headers["mcp-protocol-version"] !== "string" ||
        request.headers["mcp-protocol-version"].length === 0)
    ) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32020,
            message: "Bad Request: MCP-Protocol-Version header is required",
          },
          id: null,
        }),
      );
      return;
    }

    (request as AuthenticatedRequest).auth = authInfo;
    if (request.method === undefined) {
      response.writeHead(400).end();
      return;
    }
    void serveMcp(
      request as AuthenticatedRequest & { method: string; url: string },
      response,
    );
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });

  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("Loopback fixture did not expose a TCP address");
  }

  return {
    url: new URL(`http://127.0.0.1:${String(address.port)}/mcp`),
    transcript,
    executionCount: () => executions,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    },
  };
}
