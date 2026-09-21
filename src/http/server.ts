import { createServer, type IncomingMessage } from "node:http";

import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  type AuthInfo,
  type McpServer,
} from "@modelcontextprotocol/server";

import type { BearerAuth } from "./auth.js";

const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "::1", "[::1]"];

export interface ParsedListen {
  host: string;
  port: number;
}

/** `host:port`（含裸 IPv6 需以 `[]` 包住）。 */
export function parseListen(listen: string): ParsedListen {
  const separatorIndex = listen.lastIndexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`listen 格式錯誤，需為 host:port：${listen}`);
  }
  const host = listen.slice(0, separatorIndex);
  const portText = listen.slice(separatorIndex + 1);
  const port = Number(portText);
  if (
    host.length === 0 ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  ) {
    throw new Error(`listen 格式錯誤，需為 host:port：${listen}`);
  }
  return { host, port };
}

export interface StartHttpServerOptions {
  listen: string;
  serverFactory: (caller?: string) => McpServer;
  auth: BearerAuth;
}

export interface HttpServerHandle {
  url: string;
  close(): Promise<void>;
}

function firstHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * 把 `serverFactory` 掛到 Node HTTP server：stateless `createMcpHandler`
 * （不用 MCP session），前面依序過 Host / Origin 驗證與 bearer 驗證；
 * bearer 驗過的 caller 名稱以 `AuthInfo.clientId` 傳入 factory。
 */
export async function startHttpServer(
  options: StartHttpServerOptions,
): Promise<HttpServerHandle> {
  const { host, port } = parseListen(options.listen);
  const isLoopback = LOOPBACK_HOSTNAMES.includes(host);

  const handler = createMcpHandler((ctx) =>
    options.serverFactory(ctx.authInfo?.clientId),
  );
  const nodeHandler = toNodeHandler(handler);

  const validateHost = isLoopback
    ? localhostHostValidation()
    : hostHeaderValidation([host]);
  const validateOrigin = isLoopback
    ? localhostOriginValidation()
    : originValidation([host]);

  const httpServer = createServer((request, response) => {
    if (
      !validateHost(request, response) ||
      !validateOrigin(request, response)
    ) {
      return;
    }
    const authResult = options.auth(
      firstHeaderValue(request.headers.authorization),
    );
    if (!authResult.ok) {
      response.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": "Bearer",
      });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const authenticatedRequest = request as IncomingMessage & {
      auth?: AuthInfo;
      method: string;
      url: string;
    };
    authenticatedRequest.auth = {
      token: firstHeaderValue(request.headers.authorization) ?? "",
      clientId: authResult.caller,
      scopes: [],
    };
    void nodeHandler(authenticatedRequest, response);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });

  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("HTTP server 未取得 TCP address");
  }

  return {
    url: `http://${host}:${String(address.port)}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}
