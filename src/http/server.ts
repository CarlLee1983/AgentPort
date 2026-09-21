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
import { hostnameOf, isLoopbackHost, parseListen } from "./listen.js";

export type { ParsedListen } from "./listen.js";
export { parseListen } from "./listen.js";

export interface StartHttpServerOptions {
  listen: string;
  serverFactory: (caller?: string) => McpServer;
  auth: BearerAuth;
  /**
   * 非 loopback `listen` 時的 Host / Origin 允許清單（`loadConfig` 已驗證非
   * loopback 監聽一定會有值）；loopback 監聽時忽略，一律用 SDK 內建的
   * loopback 驗證。項目可以是 `host` 或 `host:port`。
   */
  allowedHosts?: string[];
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
 * 驗證過的 caller 名稱以 `clientId` 傳給 server factory；`token` 不放原始
 * bearer token（已經驗證過、之後也只認 `clientId`，沒有理由讓它繼續在記憶體
 * 裡流轉），一律填固定字串。
 */
export function buildAuthInfo(caller: string): AuthInfo {
  return { token: "redacted", clientId: caller, scopes: [] };
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
  const isLoopback = isLoopbackHost(host);
  const allowedHostnames = (options.allowedHosts ?? []).map(hostnameOf);

  const handler = createMcpHandler((ctx) =>
    options.serverFactory(ctx.authInfo?.clientId),
  );
  const nodeHandler = toNodeHandler(handler);

  const validateHost = isLoopback
    ? localhostHostValidation()
    : hostHeaderValidation(allowedHostnames);
  const validateOrigin = isLoopback
    ? localhostOriginValidation()
    : originValidation(allowedHostnames);

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
    authenticatedRequest.auth = buildAuthInfo(authResult.caller);
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
