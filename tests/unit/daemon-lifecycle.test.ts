import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";

import type { ControlledRuntimeAdmissionComposition } from "../../src/bootstrap/create-controlled-runtime-admission.js";
import type { DaemonConfiguration } from "../../src/daemon/configuration.js";
import type { DaemonCredentials } from "../../src/daemon/credentials.js";
import {
  DAEMON_SHUTDOWN_FAILED,
  ProductionDaemonLifecycle,
} from "../../src/daemon/lifecycle.js";
import {
  LOOPBACK_LISTENER_BIND_FAILED,
  LoopbackListenerBindError,
  type LoopbackDurableAdmissionServer,
} from "../../src/mcp/loopback-server.js";

const configuration: DaemonConfiguration = {
  mcp: { port: 3333 },
  storage: { databasePath: "/var/lib/agentport/daemon/test.sqlite" },
  launcher: {
    socketPath: "/run/agentport/launcher.sock",
    workerIngressDirectory: "/run/agentport-ingress",
    runtimeGroupId: 1002,
    ingressGroupId: 1003,
  },
  agents: [],
  principals: [],
};

const credentials: DaemonCredentials = {
  cursorSecret: "cursor-secret-at-least-sixteen",
  continuationEncryptionKey: "A".repeat(43),
};

function fixture(options: { stopUnknown?: number } = {}) {
  const events: string[] = [];
  let shutdownBegan = false;
  let dispatchOpen = false;
  const composition: ControlledRuntimeAdmissionComposition = {
    registry: {
      authenticate: () => undefined,
    } as unknown as ControlledRuntimeAdmissionComposition["registry"],
    service: {} as ControlledRuntimeAdmissionComposition["service"],
    mcpHandler: {} as McpHttpHandler,
    auditRecorder: {
      recordAudit: () => Promise.resolve(),
      flushAudit: () => Promise.resolve(),
    },
    dispatch: () =>
      Promise.resolve(
        dispatchOpen ? { kind: "started" } : { kind: "unavailable" },
      ),
    initializeAfterRestart: () => {
      events.push("initialize");
      dispatchOpen = true;
      return Promise.resolve();
    },
    beginShutdown: () => {
      if (shutdownBegan) return;
      shutdownBegan = true;
      dispatchOpen = false;
      events.push("begin-shutdown");
    },
    prepareForDaemonShutdown: () => {
      events.push("shutdown");
      return Promise.resolve({
        activeExecutions: options.stopUnknown ?? 0,
        stopConfirmed: 0,
        stopUnknown: options.stopUnknown ?? 0,
      });
    },
    close: () => {
      events.push("composition-close");
      return Promise.resolve();
    },
    forceClose: () => {
      events.push("composition-force-close");
      return Promise.resolve();
    },
  };
  let accepting = true;
  const listener: LoopbackDurableAdmissionServer = {
    url: new URL("http://127.0.0.1:3333/mcp"),
    get accepting() {
      return accepting;
    },
    activeRequestCount: 0,
    flushAudit: () => Promise.resolve(),
    stopAccepting: () => {
      if (!accepting) return;
      accepting = false;
      events.push("stop-accepting");
    },
    drainRequests: () => {
      events.push("drain");
      return Promise.resolve();
    },
    close: () => {
      events.push("listener-close");
      return Promise.resolve();
    },
    forceClose: () => {
      events.push("listener-force-close");
    },
  };
  const lifecycle = new ProductionDaemonLifecycle(
    configuration,
    credentials,
    {
      prepareComposition: () => {
        events.push("prepare");
        return Promise.resolve(composition);
      },
      startListener: () => {
        events.push("listen");
        return Promise.resolve(listener);
      },
    },
    1_000,
  );
  return { lifecycle, events, composition, listener };
}

describe("production daemon lifecycle", () => {
  it("binds before reconciliation and opens only after initialization", async () => {
    const { lifecycle, events } = fixture();
    await lifecycle.start();
    expect(lifecycle.state).toBe("running");
    expect(events).toEqual(["prepare", "listen", "initialize"]);
    await lifecycle.stop();
  });

  it("shares repeated shutdown and preserves cleanup ordering", async () => {
    const { lifecycle, events } = fixture();
    await lifecycle.start();
    const first = lifecycle.stop();
    const second = lifecycle.stop();
    expect(second).toBe(first);
    await first;
    expect(lifecycle.state).toBe("stopped");
    expect(events).toEqual([
      "prepare",
      "listen",
      "initialize",
      "stop-accepting",
      "begin-shutdown",
      "drain",
      "shutdown",
      "listener-close",
      "composition-close",
    ]);
  });

  it("closes the dispatch fence synchronously before draining requests", async () => {
    const { lifecycle, composition, listener } = fixture();
    let releaseDrain: (() => void) | undefined;
    listener.drainRequests = () =>
      new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
    await lifecycle.start();
    await expect(composition.dispatch("before-stop")).resolves.toEqual({
      kind: "started",
    });
    const stopping = lifecycle.stop();
    await expect(composition.dispatch("after-stop")).resolves.toEqual({
      kind: "unavailable",
    });
    releaseDrain?.();
    await stopping;
  });

  it("never reopens after a stop requested during starting", async () => {
    let releasePreparation: (() => void) | undefined;
    const prepared = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const { lifecycle, composition, listener } = fixture();
    const startListener = vi.fn(() => Promise.resolve(listener));
    const stopping = new ProductionDaemonLifecycle(
      configuration,
      credentials,
      {
        prepareComposition: async () => {
          await prepared;
          return composition;
        },
        startListener,
      },
      1_000,
    );
    const starting = stopping.start();
    const stopped = stopping.stop();
    releasePreparation?.();
    await Promise.all([starting, stopped]);
    expect(stopping.state).toBe("stopped");
    expect(startListener).not.toHaveBeenCalled();
    // Keep the first fixture from owning any resources after this test.
    await lifecycle.stop();
  });

  it("does not reconcile when the fixed port cannot be bound", async () => {
    const { composition, events } = fixture();
    const initialize = vi.spyOn(composition, "initializeAfterRestart");
    const lifecycle = new ProductionDaemonLifecycle(
      configuration,
      credentials,
      {
        prepareComposition: () => Promise.resolve(composition),
        startListener: () => Promise.reject(new LoopbackListenerBindError()),
      },
      1_000,
    );
    await expect(lifecycle.start()).rejects.toMatchObject({
      code: LOOPBACK_LISTENER_BIND_FAILED,
    });
    expect(initialize).not.toHaveBeenCalled();
    expect(events).toEqual(["begin-shutdown", "composition-close"]);
    expect(lifecycle.state).toBe("stopped");
  });

  it("reports unknown Supervisor stop only after closing owned resources", async () => {
    const { lifecycle, events } = fixture({ stopUnknown: 1 });
    await lifecycle.start();
    await expect(lifecycle.stop()).rejects.toMatchObject({
      code: DAEMON_SHUTDOWN_FAILED,
    });
    expect(events.slice(-2)).toEqual(["listener-close", "composition-close"]);
    expect(lifecycle.state).toBe("stopped");
  });

  it("forces only owned resources when request drain exceeds the deadline", async () => {
    const { composition, listener, events } = fixture();
    listener.drainRequests = () => new Promise<void>(() => undefined);
    listener.close = () => new Promise<void>(() => undefined);
    const lifecycle = new ProductionDaemonLifecycle(
      configuration,
      credentials,
      {
        prepareComposition: () => Promise.resolve(composition),
        startListener: () => Promise.resolve(listener),
      },
      10,
    );
    await lifecycle.start();
    await expect(lifecycle.stop()).rejects.toMatchObject({
      code: DAEMON_SHUTDOWN_FAILED,
    });
    expect(events).toContain("begin-shutdown");
    expect(events).toContain("listener-force-close");
    expect(events).toContain("composition-force-close");
    expect(events).not.toContain("shutdown");
    expect(lifecycle.state).toBe("stopped");
  });

  it("bounds a shutdown convergence promise that never resolves", async () => {
    const { composition, listener, events } = fixture();
    composition.prepareForDaemonShutdown = () => new Promise(() => undefined);
    const lifecycle = new ProductionDaemonLifecycle(
      configuration,
      credentials,
      {
        prepareComposition: () => Promise.resolve(composition),
        startListener: () => Promise.resolve(listener),
      },
      10,
    );
    await lifecycle.start();
    await expect(lifecycle.stop()).rejects.toMatchObject({
      code: DAEMON_SHUTDOWN_FAILED,
    });
    expect(events).toContain("listener-close");
    expect(events).toContain("composition-close");
    expect(lifecycle.state).toBe("stopped");
  });

  it("bounds cleanup after a partial startup failure", async () => {
    const { composition, listener, events } = fixture();
    composition.initializeAfterRestart = () =>
      Promise.reject(new Error("startup cause must not escape"));
    listener.close = () => new Promise<void>(() => undefined);
    const lifecycle = new ProductionDaemonLifecycle(
      configuration,
      credentials,
      {
        prepareComposition: () => Promise.resolve(composition),
        startListener: () => Promise.resolve(listener),
      },
      10,
    );
    await expect(lifecycle.start()).rejects.toMatchObject({
      code: "daemon_startup_failed",
    });
    expect(events).toContain("begin-shutdown");
    expect(events).toContain("listener-force-close");
    expect(events).toContain("composition-force-close");
    expect(lifecycle.state).toBe("stopped");
  });
});
