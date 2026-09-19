import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import type { AuthInfo, McpHttpHandler } from "@modelcontextprotocol/server";

import type { AgentRegistry } from "../bootstrap/registry.js";
import type {
  SanitizedAuditRecord,
  SqliteDurableAdmissionStore,
} from "../storage/sqlite-durable-admission-store.js";
import {
  DURABLE_ADMISSION_TOOL_NAMES,
  MCP_PROTOCOL_VERSION,
} from "./protocol.js";

export const LOOPBACK_MAX_REQUEST_BODY_BYTES = 128 * 1024;
export const LOOPBACK_LISTENER_BIND_FAILED = "loopback_listener_bind_failed";

export class LoopbackListenerBindError extends Error {
  readonly code = LOOPBACK_LISTENER_BIND_FAILED;

  constructor() {
    super(LOOPBACK_LISTENER_BIND_FAILED);
    this.name = "LoopbackListenerBindError";
  }
}

interface AuthenticatedRequest extends IncomingMessage {
  auth?: AuthInfo;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface LoopbackDurableAdmissionServer {
  url: URL;
  readonly accepting: boolean;
  readonly activeRequestCount: number;
  flushAudit(): Promise<void>;
  /** Synchronously closes the listener and rejects later request admission. */
  stopAccepting(): void;
  /** Waits only for requests already admitted to finish their HTTP response. */
  drainRequests(): Promise<void>;
  close(): Promise<void>;
  /** Deadline fallback; destroys only connections owned by this listener. */
  forceClose(): void;
}

type ProductAuditRecorder = Pick<
  SqliteDurableAdmissionStore,
  "flushAudit" | "recordAudit"
>;

function boundedAuditText(value: unknown, maximumBytes: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
    ? value
    : null;
}

function auditFingerprint(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const encoded = typeof value === "string" ? value : JSON.stringify(value);
  return `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
}

function auditProtocolVersion(value: unknown): string | null {
  const protocolVersion = boundedAuditText(value, 64);
  if (protocolVersion === null) return null;
  return protocolVersion === MCP_PROTOCOL_VERSION
    ? MCP_PROTOCOL_VERSION
    : "unsupported";
}

function auditRequest(
  body: unknown,
  principalId: string | null,
  resultCode: string,
  fallback: { method?: unknown; protocolVersion?: unknown } = {},
): SanitizedAuditRecord {
  const request = isRecord(body) ? body : {};
  const params = isRecord(request.params) ? request.params : {};
  const meta = isRecord(params._meta) ? params._meta : {};
  const clientInfo = isRecord(meta["io.modelcontextprotocol/clientInfo"])
    ? meta["io.modelcontextprotocol/clientInfo"]
    : {};
  const capabilities = meta["io.modelcontextprotocol/clientCapabilities"];
  const capabilityFingerprint = isRecord(capabilities)
    ? auditFingerprint(capabilities)
    : null;
  const candidateMethod = boundedAuditText(
    request.method ?? fallback.method,
    128,
  );
  const method =
    candidateMethod !== null &&
    [
      "initialize",
      "notifications/initialized",
      "ping",
      "server/discover",
      "tools/call",
      "tools/list",
    ].includes(candidateMethod)
      ? candidateMethod
      : "unknown_request";
  const candidateTool =
    method === "tools/call" ? boundedAuditText(params.name, 128) : null;
  return {
    principalId: boundedAuditText(principalId, 128),
    method,
    toolName:
      candidateTool !== null &&
      DURABLE_ADMISSION_TOOL_NAMES.includes(
        candidateTool as (typeof DURABLE_ADMISSION_TOOL_NAMES)[number],
      )
        ? candidateTool
        : candidateTool === null
          ? null
          : "unknown",
    protocolVersion: auditProtocolVersion(
      meta["io.modelcontextprotocol/protocolVersion"] ??
        fallback.protocolVersion,
    ),
    clientName: auditFingerprint(clientInfo.name),
    clientVersion: auditFingerprint(clientInfo.version),
    clientCapabilitiesJson:
      capabilityFingerprint === null
        ? null
        : JSON.stringify({ sha256: capabilityFingerprint.slice(7) }),
    resultCode,
    createdAt: new Date().toISOString(),
  };
}

async function auditResultCode(response: Response): Promise<string> {
  if (response.status === 401) return "unauthorized";
  try {
    const body: unknown = await response.clone().json();
    if (!isRecord(body)) return response.ok ? "ok" : "protocol_error";
    const result = isRecord(body.result) ? body.result : {};
    const structured = isRecord(result.structuredContent)
      ? result.structuredContent
      : {};
    if (structured.ok === true) return "ok";
    if (structured.ok === false && isRecord(structured.error)) {
      return boundedAuditText(structured.error.code, 128) ?? "internal_error";
    }
    return isRecord(body.error) ? "protocol_error" : "ok";
  } catch {
    return response.ok ? "ok" : "protocol_error";
  }
}

function authenticate(
  request: IncomingMessage,
  registry: AgentRegistry,
): AuthInfo | undefined {
  const authorization = request.headers.authorization;
  if (
    authorization === undefined ||
    Array.isArray(authorization) ||
    !authorization.startsWith("Bearer ")
  ) {
    return undefined;
  }
  const token = authorization.slice("Bearer ".length);
  if (token.length === 0) return undefined;
  const principalId = registry.authenticate(token);
  if (principalId === undefined) return undefined;
  return {
    token,
    clientId: principalId,
    scopes: ["agentport:durable-admission"],
  };
}

function rejectUnauthorized(
  response: import("node:http").ServerResponse,
): void {
  response.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": "Bearer",
  });
  response.end(JSON.stringify({ error: "unauthorized" }));
}

function rejectBadRequest(
  response: import("node:http").ServerResponse,
  code: number,
  message: string,
  status = 400,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
  );
}

function rejectAdmissionUnavailable(
  response: import("node:http").ServerResponse,
): void {
  rejectBadRequest(response, -32_003, "Admission unavailable", 503);
}

function admissionIsOpen(canAcceptRequest?: () => boolean): boolean {
  try {
    return canAcceptRequest?.() !== false;
  } catch {
    return false;
  }
}

function rejectUnknownTool(
  response: import("node:http").ServerResponse,
  id: unknown,
): void {
  response.writeHead(200, {
    "content-type": "application/json",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: typeof id === "string" || typeof id === "number" ? id : null,
      error: { code: -32_602, message: "Unknown tool" },
    }),
  );
}

function rejectUnknownMethod(
  response: import("node:http").ServerResponse,
  id: unknown,
): void {
  response.writeHead(200, {
    "content-type": "application/json",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: typeof id === "string" || typeof id === "number" ? id : null,
      error: { code: -32_601, message: "Method not found" },
    }),
  );
}

function hasExpectedEnvelope(body: unknown): boolean {
  if (!isRecord(body) || !isRecord(body.params)) return false;
  const meta = body.params._meta;
  return (
    isRecord(meta) &&
    meta["io.modelcontextprotocol/protocolVersion"] === MCP_PROTOCOL_VERSION
  );
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > LOOPBACK_MAX_REQUEST_BODY_BYTES) {
      throw new RangeError("request body too large");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return undefined;
  return JSON.parse(text) as unknown;
}

export async function startLoopbackDurableAdmissionServer(options: {
  registry: AgentRegistry;
  handler: McpHttpHandler;
  auditRecorder: ProductAuditRecorder;
  /** Omit for the existing ephemeral-port test fixture behavior. */
  port?: number;
  /** Lifecycle-owned admission fence for otherwise valid MCP requests. */
  canAcceptRequest?: () => boolean;
}): Promise<LoopbackDurableAdmissionServer> {
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) ||
      options.port <= 0 ||
      options.port > 65_535)
  ) {
    throw new LoopbackListenerBindError();
  }
  const enqueueAudit = (record: SanitizedAuditRecord): void => {
    void options.auditRecorder.recordAudit(record).catch(() => undefined);
  };
  const flushAudit = async (): Promise<void> => {
    await options.auditRecorder.flushAudit();
  };
  const auditedHandler: McpHttpHandler = {
    ...options.handler,
    fetch: async (request, handlerOptions) => {
      const fallback = {
        method: request.headers.get("mcp-method"),
        protocolVersion: request.headers.get("mcp-protocol-version"),
      };
      try {
        const response = await options.handler.fetch(request, handlerOptions);
        const resultCode = await auditResultCode(response);
        enqueueAudit(
          auditRequest(
            handlerOptions?.parsedBody,
            handlerOptions?.authInfo?.clientId ?? null,
            resultCode,
            fallback,
          ),
        );
        return response;
      } catch (error) {
        enqueueAudit(
          auditRequest(
            handlerOptions?.parsedBody,
            handlerOptions?.authInfo?.clientId ?? null,
            "internal_error",
            fallback,
          ),
        );
        throw error;
      }
    },
  };
  const serveMcp = toNodeHandler(auditedHandler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  let accepting = true;
  let activeRequestCount = 0;
  let listenerDrain: Promise<void> | undefined;
  let resolveRequestDrain: (() => void) | undefined;
  let requestDrain = Promise.resolve();
  const beginRequest = (): void => {
    if (activeRequestCount === 0) {
      requestDrain = new Promise<void>((resolve) => {
        resolveRequestDrain = resolve;
      });
    }
    activeRequestCount += 1;
  };
  const endRequest = (): void => {
    activeRequestCount -= 1;
    if (activeRequestCount === 0) {
      resolveRequestDrain?.();
      resolveRequestDrain = undefined;
    }
  };
  const httpServer = createServer((request, response) => {
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    if (
      !validateHost(request, response) ||
      !validateOrigin(request, response)
    ) {
      return;
    }
    const authInfo = authenticate(request, options.registry);
    if (authInfo === undefined) {
      enqueueAudit(
        auditRequest(undefined, null, "unauthorized", {
          method: request.headers["mcp-method"] ?? request.method,
          protocolVersion: request.headers["mcp-protocol-version"],
        }),
      );
      rejectUnauthorized(response);
      return;
    }
    if (!accepting || !admissionIsOpen(options.canAcceptRequest)) {
      enqueueAudit(
        auditRequest(undefined, authInfo.clientId, "admission_unavailable", {
          method: request.headers["mcp-method"] ?? request.method,
          protocolVersion: request.headers["mcp-protocol-version"],
        }),
      );
      rejectAdmissionUnavailable(response);
      return;
    }
    const declaredMethod = request.headers["mcp-method"];
    const legacyLifecycle =
      declaredMethod === "initialize" ||
      declaredMethod === "notifications/initialized";
    if (
      request.method === "POST" &&
      !legacyLifecycle &&
      request.headers["mcp-protocol-version"] !== MCP_PROTOCOL_VERSION
    ) {
      enqueueAudit(
        auditRequest(undefined, authInfo.clientId, "unsupported_protocol", {
          method: declaredMethod ?? request.method,
          protocolVersion: request.headers["mcp-protocol-version"],
        }),
      );
      rejectBadRequest(
        response,
        -32_022,
        "Unsupported or missing protocol version",
      );
      return;
    }
    const authenticatedRequest = request as AuthenticatedRequest;
    authenticatedRequest.auth = authInfo;
    if (request.method === undefined) {
      response.writeHead(400).end();
      return;
    }
    beginRequest();
    let requestEnded = false;
    const endTrackedRequest = (): void => {
      if (requestEnded) return;
      requestEnded = true;
      endRequest();
    };
    void (async () => {
      let parsedBody: unknown;
      if (request.method === "POST") {
        try {
          parsedBody = await readBody(request);
        } catch (error) {
          enqueueAudit(
            auditRequest(undefined, authInfo.clientId, "invalid_request", {
              method: declaredMethod ?? request.method,
              protocolVersion: request.headers["mcp-protocol-version"],
            }),
          );
          if (error instanceof RangeError) {
            rejectBadRequest(
              response,
              -32_000,
              "Request body is too large",
              413,
            );
          } else {
            rejectBadRequest(response, -32_700, "Parse error");
          }
          return;
        }
        if (!isRecord(parsedBody) || typeof parsedBody.method !== "string") {
          enqueueAudit(
            auditRequest(parsedBody, authInfo.clientId, "invalid_request", {
              method: declaredMethod ?? request.method,
              protocolVersion: request.headers["mcp-protocol-version"],
            }),
          );
          rejectBadRequest(response, -32_600, "Invalid request");
          return;
        }
        const actualLegacyLifecycle =
          parsedBody.method === "initialize" ||
          parsedBody.method === "notifications/initialized";
        if (
          (typeof declaredMethod === "string" &&
            declaredMethod !== parsedBody.method) ||
          (!actualLegacyLifecycle &&
            request.headers["mcp-protocol-version"] !== MCP_PROTOCOL_VERSION)
        ) {
          enqueueAudit(
            auditRequest(
              parsedBody,
              authInfo.clientId,
              "invalid_protocol_metadata",
              {
                method: declaredMethod ?? request.method,
                protocolVersion: request.headers["mcp-protocol-version"],
              },
            ),
          );
          rejectBadRequest(response, -32_022, "Invalid protocol metadata");
          return;
        }
        if (!actualLegacyLifecycle && !hasExpectedEnvelope(parsedBody)) {
          enqueueAudit(
            auditRequest(
              parsedBody,
              authInfo.clientId,
              "unsupported_protocol",
              {
                method: declaredMethod ?? request.method,
                protocolVersion: request.headers["mcp-protocol-version"],
              },
            ),
          );
          rejectBadRequest(
            response,
            -32_022,
            "Unsupported or incomplete protocol envelope",
          );
          return;
        }
        if (
          ![
            "initialize",
            "notifications/initialized",
            "ping",
            "server/discover",
            "tools/call",
            "tools/list",
          ].includes(parsedBody.method)
        ) {
          enqueueAudit(
            auditRequest(parsedBody, authInfo.clientId, "unknown_method"),
          );
          rejectUnknownMethod(response, parsedBody.id);
          return;
        }
        const params = isRecord(parsedBody.params) ? parsedBody.params : {};
        if (
          parsedBody.method === "tools/call" &&
          request.headers["mcp-name"] !== params.name
        ) {
          enqueueAudit(
            auditRequest(
              parsedBody,
              authInfo.clientId,
              "invalid_protocol_metadata",
            ),
          );
          rejectBadRequest(response, -32_022, "Invalid protocol metadata");
          return;
        }
        if (
          parsedBody.method === "tools/call" &&
          (typeof params.name !== "string" ||
            !DURABLE_ADMISSION_TOOL_NAMES.includes(
              params.name as (typeof DURABLE_ADMISSION_TOOL_NAMES)[number],
            ))
        ) {
          enqueueAudit(
            auditRequest(parsedBody, authInfo.clientId, "unknown_tool"),
          );
          rejectUnknownTool(response, parsedBody.id);
          return;
        }
      }
      try {
        await serveMcp(
          authenticatedRequest as AuthenticatedRequest & {
            method: string;
            url: string;
          },
          response,
          parsedBody,
        );
      } catch {
        if (!response.headersSent) {
          rejectBadRequest(response, -32_603, "Internal protocol error", 500);
        } else {
          response.destroy();
        }
      }
    })()
      .catch(() => {
        if (!response.headersSent) {
          rejectBadRequest(response, -32_603, "Internal protocol error", 500);
        } else {
          response.destroy();
        }
      })
      .finally(endTrackedRequest);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(options.port ?? 0, "127.0.0.1", resolve);
    });
  } catch {
    httpServer.close();
    throw new LoopbackListenerBindError();
  }
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("Loopback MCP server did not expose a TCP address");
  }
  return {
    url: new URL(`http://127.0.0.1:${String(address.port)}/mcp`),
    get accepting(): boolean {
      return accepting;
    },
    get activeRequestCount(): number {
      return activeRequestCount;
    },
    flushAudit,
    stopAccepting: () => {
      if (!accepting) return;
      accepting = false;
      listenerDrain = new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    },
    drainRequests: async () => requestDrain,
    close: async () => {
      if (accepting) {
        accepting = false;
        listenerDrain = new Promise<void>((resolve, reject) => {
          httpServer.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        });
      }
      await Promise.all([listenerDrain, requestDrain]);
      await flushAudit();
    },
    forceClose: () => {
      accepting = false;
      httpServer.closeAllConnections();
      httpServer.close();
    },
  };
}
