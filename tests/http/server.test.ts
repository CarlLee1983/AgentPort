import { request as httpRequest } from "node:http";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempDirs } from "../config/helpers.js";
import { createTestHttpApp, type TestHttpApp } from "../helpers/http-app.js";
import { unavailableDrivers } from "../helpers/unavailable-driver.js";

afterEach(cleanupTempDirs);

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** 用 `node:http` 直接送請求，方便控制 `Host` header（`fetch` 會擋掉這個 header）。 */
function rawRequest(
  url: URL,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: options.method ?? "POST", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function connect(url: URL, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

describe("HTTP transport 與 bearer 驗證", () => {
  let app: TestHttpApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("無 token 回 401 並帶 WWW-Authenticate", async () => {
    app = await createTestHttpApp(unavailableDrivers, [
      { name: "grok", tokenEnv: "AGENTPORT_TOKEN_GROK", token: "secret-1" },
    ]);
    const response = await rawRequest(new URL(app.handle.url));
    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
  });

  it("錯 token 回 401", async () => {
    app = await createTestHttpApp(unavailableDrivers, [
      { name: "grok", tokenEnv: "AGENTPORT_TOKEN_GROK", token: "secret-1" },
    ]);
    const response = await rawRequest(new URL(app.handle.url), {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(response.status).toBe(401);
  });

  it("正確 token 可呼叫 list_agents，submit_task 記錄的 caller 為對應名稱", async () => {
    app = await createTestHttpApp(unavailableDrivers, [
      { name: "grok", tokenEnv: "AGENTPORT_TOKEN_GROK", token: "secret-1" },
    ]);
    const client = await connect(new URL(app.handle.url), "secret-1");
    try {
      const listResponse = await client.callTool({
        name: "list_agents",
        arguments: {},
      });
      expect(listResponse.isError).toBeFalsy();

      const submitResponse = await client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "hello" },
      });
      const { task_id: taskId } = submitResponse.structuredContent as {
        task_id: string;
      };
      const task = app.store.getTask(taskId);
      expect(task?.caller).toBe("grok");
    } finally {
      await client.close();
    }
  });

  it("Host header 非 loopback 且未允許時回 4xx", async () => {
    app = await createTestHttpApp(unavailableDrivers, [
      { name: "grok", tokenEnv: "AGENTPORT_TOKEN_GROK", token: "secret-1" },
    ]);
    const url = new URL(app.handle.url);
    const response = await rawRequest(url, {
      headers: {
        Authorization: "Bearer secret-1",
        Host: "evil.example.com",
      },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it("兩個 caller 各自的 token 分別記錄", async () => {
    app = await createTestHttpApp(unavailableDrivers, [
      { name: "grok", tokenEnv: "AGENTPORT_TOKEN_GROK", token: "secret-1" },
      {
        name: "codex-ci",
        tokenEnv: "AGENTPORT_TOKEN_CODEX",
        token: "secret-2",
      },
    ]);
    const url = new URL(app.handle.url);

    const grokClient = await connect(url, "secret-1");
    const codexClient = await connect(url, "secret-2");
    try {
      const grokSubmit = await grokClient.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "from grok" },
      });
      const codexSubmit = await codexClient.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "from codex" },
      });

      const grokTaskId = (grokSubmit.structuredContent as { task_id: string })
        .task_id;
      const codexTaskId = (codexSubmit.structuredContent as { task_id: string })
        .task_id;

      expect(app.store.getTask(grokTaskId)?.caller).toBe("grok");
      expect(app.store.getTask(codexTaskId)?.caller).toBe("codex-ci");
    } finally {
      await grokClient.close();
      await codexClient.close();
    }
  });
});
