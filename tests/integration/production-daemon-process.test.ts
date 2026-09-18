import { once } from "node:events";
import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

const signalChild = String.raw`
import { ProductionDaemonLifecycle } from "./dist/src/daemon/lifecycle.js";
import { startLoopbackDurableAdmissionServer } from "./dist/src/mcp/loopback-server.js";

const events = [];
let shutdownBegan = false;
const handler = { fetch: async () => new Response("{}"), close: async () => undefined };
const composition = {
  registry: { authenticate: () => undefined },
  service: {},
  mcpHandler: handler,
  auditRecorder: { recordAudit: async () => undefined, flushAudit: async () => undefined },
  dispatch: async () => ({ kind: "unavailable" }),
  initializeAfterRestart: async () => events.push("initialized"),
  beginShutdown: () => {
    if (shutdownBegan) return;
    shutdownBegan = true;
    events.push("begin-shutdown");
  },
  prepareForDaemonShutdown: async () => {
    events.push("shutdown");
    return { activeExecutions: 0, stopConfirmed: 0, stopUnknown: 0 };
  },
  close: async () => events.push("composition-closed"),
  forceClose: async () => events.push("composition-force-closed"),
};
const port = Number.parseInt(process.argv[1], 10);
const lifecycle = new ProductionDaemonLifecycle(
  {
    mcp: { port },
    storage: { databasePath: "/unreached.sqlite" },
    launcher: {
      socketPath: "/unreached-launcher.sock",
      workerIngressDirectory: "/unreached-ingress",
      runtimeGroupId: 1002,
      ingressGroupId: 1003,
    },
    agents: [],
    principals: [],
  },
  { cursorSecret: "cursor-secret-at-least-sixteen", continuationEncryptionKey: "A".repeat(43) },
  {
    prepareComposition: async () => composition,
    startListener: ({ composition: value, port: fixedPort, canAcceptRequest }) =>
      startLoopbackDurableAdmissionServer({
        registry: value.registry,
        handler: value.mcpHandler,
        auditRecorder: value.auditRecorder,
        port: fixedPort,
        canAcceptRequest,
      }),
  },
  2_000,
);
await lifecycle.start();
process.stdout.write("READY\n");
let stopped;
const stop = () => {
  stopped ??= lifecycle.stop().then(() => {
    process.stdout.write(JSON.stringify({ state: lifecycle.state, events }) + "\n");
  });
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise((resolve, reject) => {
  const check = setInterval(() => {
    if (stopped !== undefined) {
      clearInterval(check);
      stopped.then(resolve, reject);
    }
  }, 5);
});
`;

const hungStartupChild = String.raw`
import { daemonMain } from "./dist/src/daemon/main.js";
const configuration = {
  mcp: { port: 3333 },
  storage: { databasePath: "/unreached.sqlite" },
  launcher: {
    socketPath: "/unreached-launcher.sock",
    workerIngressDirectory: "/unreached-ingress",
    runtimeGroupId: 1002,
    ingressGroupId: 1003,
  },
  agents: [],
  principals: [],
};
let startupKeepalive;
const code = await daemonMain(["--config", "/etc/agentport/agentport.json"], {
  getUid: () => 995,
  readConfiguration: () => Promise.resolve(configuration),
  readCredentials: () => Promise.resolve({
    cursorSecret: "cursor-secret-at-least-sixteen",
    continuationEncryptionKey: "A".repeat(43),
  }),
  createLifecycle: () => ({
    state: "starting",
    start: () => {
      process.stdout.write("READY\n");
      startupKeepalive = setInterval(() => undefined, 1_000);
      return new Promise(() => undefined);
    },
    stop: () => {
      clearInterval(startupKeepalive);
      return Promise.resolve();
    },
  }),
  onSignal: (signal, listener) => process.on(signal, listener),
  offSignal: (signal, listener) => process.off(signal, listener),
  writeError: (line) => process.stderr.write(line + "\n"),
});
process.exitCode = code;
`;

async function unusedPort(): Promise<number> {
  const { createServer } = await import("node:net");
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test listener did not bind TCP");
  }
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

describe("compiled production daemon process", () => {
  it("can be imported without starting a service", async () => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'await import("./dist/src/daemon/main.js")',
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const [code] = (await once(child, "exit")) as [number | null];
    expect(code).toBe(0);
  });

  it("handles real repeated process signals through one bounded cleanup", async () => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        signalChild,
        String(await unusedPort()),
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    await expect.poll(() => stdout, { timeout: 5_000 }).toContain("READY\n");
    child.kill("SIGTERM");
    child.kill("SIGINT");
    const [code, signal] = (await once(child, "exit")) as [
      number | null,
      NodeJS.Signals | null,
    ];
    expect({ code, signal, stderr }).toEqual({
      code: 0,
      signal: null,
      stderr: "",
    });
    const finalLine = stdout.trim().split("\n").at(-1);
    expect(finalLine).toBeDefined();
    expect(JSON.parse(finalLine ?? "{}") as unknown).toEqual({
      state: "stopped",
      events: [
        "initialized",
        "begin-shutdown",
        "shutdown",
        "composition-closed",
      ],
    });
  });

  it("does not wait for a pending startup after signal shutdown", async () => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", hungStartupChild],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    await expect.poll(() => stdout, { timeout: 5_000 }).toContain("READY\n");
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const [code, signal] = (await exited) as [
      number | null,
      NodeJS.Signals | null,
    ];
    expect({ code, signal, stderr }).toEqual({
      code: 0,
      signal: null,
      stderr: "",
    });
  });
});
