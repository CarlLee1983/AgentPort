import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import type { ControlledRuntimeAdmissionComposition } from "../../src/bootstrap/create-controlled-runtime-admission.js";
import { startAdminReadinessServer } from "../../src/daemon/admin-server.js";
import type { DaemonConfiguration } from "../../src/daemon/configuration.js";
import type { DaemonCredentials } from "../../src/daemon/credentials.js";
import { ProductionDaemonLifecycle } from "../../src/daemon/lifecycle.js";
import type { LoopbackDurableAdmissionServer } from "../../src/mcp/loopback-server.js";

async function request(path: string): Promise<unknown> {
  const socket = createConnection(path);
  let output = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => (output += chunk));
  await once(socket, "connect");
  socket.end('{"version":1,"method":"get_readiness"}\n');
  await once(socket, "close");
  return JSON.parse(output);
}

describe("production daemon administrator socket", () => {
  it("owns one read-only readiness socket for its lifecycle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentport-daemon-admin-"));
    const socketPath = join(directory, "admin.sock");
    let mutations = 0;
    const composition = {
      registry: {} as ControlledRuntimeAdmissionComposition["registry"],
      service: {} as ControlledRuntimeAdmissionComposition["service"],
      mcpHandler: {} as McpHttpHandler,
      auditRecorder: {
        recordAudit: () => Promise.resolve(),
        flushAudit: () => Promise.resolve(),
      },
      dispatch: () => Promise.resolve({ kind: "unavailable" as const }),
      initializeAfterRestart: () => Promise.resolve(),
      beginShutdown: () => {
        mutations += 1;
      },
      prepareForDaemonShutdown: () =>
        Promise.resolve({
          activeExecutions: 0,
          stopConfirmed: 0,
          stopUnknown: 0,
        }),
      close: () => Promise.resolve(),
      forceClose: () => Promise.resolve(),
      observeDeploymentReadiness: () =>
        Promise.resolve({
          observedAt: "2026-09-18T12:34:56.789Z",
          observation: "current" as const,
          capabilities: {
            service: "unavailable" as const,
            agents: "none" as const,
            launcher: "ready" as const,
            runtime: "unverified" as const,
            callerProvisioning: "absent" as const,
            protectedTopology: "valid" as const,
          },
          recovery: "clear" as const,
          storage: "healthy" as const,
        }),
    } satisfies ControlledRuntimeAdmissionComposition;
    const listener: LoopbackDurableAdmissionServer = {
      url: new URL("http://127.0.0.1:3333/mcp"),
      accepting: true,
      activeRequestCount: 0,
      flushAudit: () => Promise.resolve(),
      stopAccepting: () => undefined,
      drainRequests: () => Promise.resolve(),
      close: () => Promise.resolve(),
      forceClose: () => undefined,
    };
    const configuration: DaemonConfiguration = {
      mcp: { port: 3333 },
      storage: { databasePath: "/unreached.sqlite" },
      launcher: {
        socketPath: "/unreached-launcher.sock",
        workerIngressDirectory: "/unreached-ingress",
        socketGroupId: 1001,
        runtimeGroupId: 1002,
        ingressGroupId: 1003,
      },
      adminSocket: { groupId: process.getgid?.() ?? 0 },
      agents: [],
      principals: [],
    };
    const credentials: DaemonCredentials = {
      cursorSecret: "cursor-secret-at-least-sixteen",
      continuationEncryptionKey: "A".repeat(43),
    };
    const lifecycle = new ProductionDaemonLifecycle(
      configuration,
      credentials,
      {
        prepareComposition: () => Promise.resolve(composition),
        startListener: () => Promise.resolve(listener),
        startAdminServer: (options) =>
          startAdminReadinessServer({
            socketPath,
            groupId: process.getgid?.() ?? 0,
            readiness: options.readiness,
          }),
      },
    );

    await lifecycle.start();
    const before = mutations;
    const first = await request(socketPath);
    expect(first).toMatchObject({ version: 1, ok: true });
    expect(first).toHaveProperty("readiness.level", "service-ready");
    expect(first).toHaveProperty("readiness.reason", "no-agents-configured");
    await expect(request(socketPath)).resolves.toMatchObject({ ok: true });
    expect(mutations).toBe(before);
    await lifecycle.stop();
  });
});
