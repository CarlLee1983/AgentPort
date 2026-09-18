import { createServer } from "node:net";
import { request as httpRequest } from "node:http";

import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOOPBACK_LISTENER_BIND_FAILED,
  LoopbackListenerBindError,
  startLoopbackDurableAdmissionServer,
} from "../../src/mcp/loopback-server.js";
import { MCP_PROTOCOL_VERSION } from "../../src/mcp/protocol.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(
    resources
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
});

function requestBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
      },
    },
  });
}

function startListener(
  options: {
    port?: number;
    canAcceptRequest?: () => boolean;
    fetch?: McpHttpHandler["fetch"];
  } = {},
) {
  const recordAudit = vi.fn(() => Promise.resolve());
  const endpoint = startLoopbackDurableAdmissionServer({
    registry: {
      authenticate: (token: string) =>
        token === "listener-test-token" ? "listener-test-principal" : undefined,
    } as never,
    handler: {
      fetch:
        options.fetch ??
        (() =>
          Promise.resolve(
            new Response(
              JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
              { status: 200 },
            ),
          )),
    } as McpHttpHandler,
    auditRecorder: { recordAudit, flushAudit: () => Promise.resolve() },
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.canAcceptRequest === undefined
      ? {}
      : { canAcceptRequest: options.canAcceptRequest }),
  });
  return { endpoint, recordAudit };
}

function post(url: URL): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer listener-test-token",
      "content-type": "application/json",
      "mcp-method": "tools/list",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    },
    body: requestBody(),
  });
}

describe("production daemon loopback listener", () => {
  it("binds an explicit fixed loopback port and classifies occupied ports without fallback", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) =>
      occupied.listen(0, "127.0.0.1", resolve),
    );
    const address = occupied.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected test TCP port");
    }

    await expect(
      startListener({ port: address.port }).endpoint,
    ).rejects.toMatchObject({
      name: "LoopbackListenerBindError",
      code: LOOPBACK_LISTENER_BIND_FAILED,
      message: LOOPBACK_LISTENER_BIND_FAILED,
    });

    await new Promise<void>((resolve, reject) => {
      occupied.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
    const listener = await startListener({ port: address.port }).endpoint;
    resources.push(() => listener.close());
    expect(listener.url.hostname).toBe("127.0.0.1");
    expect(Number(listener.url.port)).toBe(address.port);
  });

  it("rejects a closed admission seam without calling the handler and records a sanitized audit outcome", async () => {
    const started = startListener({ canAcceptRequest: () => false });
    const listener = await started.endpoint;
    resources.push(() => listener.close());

    const response = await post(listener.url);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32_003, message: "Admission unavailable" },
    });
    expect(started.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        principalId: "listener-test-principal",
        resultCode: "admission_unavailable",
      }),
    );
  });

  it("synchronously fences later requests and lets close await an in-flight request", async () => {
    let releaseRequest: (() => void) | undefined;
    let beganRequest: (() => void) | undefined;
    const began = new Promise<void>((resolve) => {
      beganRequest = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const listener = await startListener({
      fetch: async () => {
        beganRequest?.();
        await blocked;
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
        );
      },
    }).endpoint;
    resources.push(() => listener.close());

    const request = post(listener.url);
    await began;
    expect(listener.activeRequestCount).toBe(1);
    listener.stopAccepting();
    expect(listener.accepting).toBe(false);
    const draining = listener.drainRequests();
    let drained = false;
    void draining.then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(drained).toBe(false);
    const closing = listener.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);

    releaseRequest?.();
    await request;
    await draining;
    await closing;
    await expect(listener.close()).resolves.toBeUndefined();
  });

  it("keeps a disconnected request in the drain set until its handler settles", async () => {
    let releaseHandler: (() => void) | undefined;
    let handlerBegan: (() => void) | undefined;
    const began = new Promise<void>((resolve) => {
      handlerBegan = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const listener = await startListener({
      fetch: async () => {
        handlerBegan?.();
        await blocked;
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
        );
      },
    }).endpoint;
    resources.push(() => listener.close());

    const request = httpRequest(listener.url, {
      method: "POST",
      headers: {
        authorization: "Bearer listener-test-token",
        "content-type": "application/json",
        "mcp-method": "tools/list",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      },
    });
    request.on("error", () => undefined);
    request.end(requestBody());
    await began;
    request.destroy();
    listener.stopAccepting();
    const draining = listener.drainRequests();
    let drained = false;
    void draining.then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(drained).toBe(false);

    releaseHandler?.();
    await draining;
    expect(listener.activeRequestCount).toBe(0);
  });

  it("rejects port zero rather than treating it as an ephemeral production listener", async () => {
    await expect(startListener({ port: 0 }).endpoint).rejects.toBeInstanceOf(
      LoopbackListenerBindError,
    );
  });
});
