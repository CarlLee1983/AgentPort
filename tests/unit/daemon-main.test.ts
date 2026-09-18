import { describe, expect, it, vi } from "vitest";

import type { DaemonConfiguration } from "../../src/daemon/configuration.js";
import type { DaemonCredentials } from "../../src/daemon/credentials.js";
import type {
  DaemonLifecycleControl,
  DaemonLifecycleState,
} from "../../src/daemon/lifecycle.js";
import {
  DAEMON_SHUTDOWN_FAILED,
  DaemonLifecycleError,
} from "../../src/daemon/lifecycle.js";
import {
  DAEMON_ARGUMENTS_INVALID,
  DAEMON_ROOT_FORBIDDEN,
  daemonMain,
  parseDaemonArguments,
  runProductionDaemon,
  type DaemonMainDependencies,
} from "../../src/daemon/main.js";

const configuration: DaemonConfiguration = {
  mcp: { port: 3333 },
  storage: { databasePath: "/var/lib/agentport/daemon/test.sqlite" },
  launcher: {
    socketPath: "/run/agentport/launcher.sock",
    workerIngressDirectory: "/run/agentport-ingress",
    socketGroupId: 1001,
    runtimeGroupId: 1002,
    ingressGroupId: 1003,
  },
  adminSocket: { groupId: 1004 },
  agents: [],
  principals: [],
};
const credentials: DaemonCredentials = {
  cursorSecret: "cursor-secret-at-least-sixteen",
  continuationEncryptionKey: "A".repeat(43),
};

function dependencies() {
  const signalListeners = new Map<string, () => void>();
  let state: DaemonLifecycleState = "stopped";
  const start = vi.fn(() => {
    state = "running";
    return Promise.resolve();
  });
  const stop = vi.fn(() => {
    state = "stopped";
    return Promise.resolve();
  });
  const lifecycle: DaemonLifecycleControl = {
    get state() {
      return state;
    },
    start,
    stop,
  };
  const errors: string[] = [];
  const value: DaemonMainDependencies = {
    getUid: () => 995,
    readConfiguration: () => Promise.resolve(configuration),
    readCredentials: () => Promise.resolve(credentials),
    createLifecycle: () => lifecycle,
    onSignal: (signal, listener) => {
      signalListeners.set(signal, listener);
    },
    offSignal: (signal) => {
      signalListeners.delete(signal);
    },
    writeError: (line) => {
      errors.push(line);
    },
  };
  return { value, lifecycle, start, stop, signalListeners, errors };
}

describe("production daemon main", () => {
  it("accepts only the explicit --config form", () => {
    expect(
      parseDaemonArguments(["--config", "/etc/agentport/agentport.json"]),
    ).toBe("/etc/agentport/agentport.json");
    expect(() => parseDaemonArguments([])).toThrow(DAEMON_ARGUMENTS_INVALID);
    expect(() =>
      parseDaemonArguments(["/etc/agentport/agentport.json"]),
    ).toThrow(DAEMON_ARGUMENTS_INVALID);
  });

  it("refuses uid 0 before reading configuration or credentials", async () => {
    const fixture = dependencies();
    const readConfiguration = vi.fn((path: string) =>
      fixture.value.readConfiguration(path),
    );
    const readCredentials = vi.fn(() => fixture.value.readCredentials());
    await expect(
      runProductionDaemon(["--config", "/etc/agentport/agentport.json"], {
        ...fixture.value,
        getUid: () => 0,
        readConfiguration,
        readCredentials,
      }),
    ).rejects.toMatchObject({ code: DAEMON_ROOT_FORBIDDEN });
    expect(readConfiguration).not.toHaveBeenCalled();
    expect(readCredentials).not.toHaveBeenCalled();
  });

  it("routes SIGINT and repeated SIGTERM through one lifecycle stop", async () => {
    const fixture = dependencies();
    const running = runProductionDaemon(
      ["--config", "/etc/agentport/agentport.json"],
      fixture.value,
    );
    await vi.waitFor(() => {
      expect(fixture.start).toHaveBeenCalled();
    });
    fixture.signalListeners.get("SIGINT")?.();
    fixture.signalListeners.get("SIGTERM")?.();
    await running;
    expect(fixture.stop).toHaveBeenCalledTimes(1);
    expect(fixture.signalListeners.size).toBe(0);
  });

  it("does not start after a signal received during configuration loading", async () => {
    const fixture = dependencies();
    let release: ((value: DaemonConfiguration) => void) | undefined;
    const configurationPending = new Promise<DaemonConfiguration>((resolve) => {
      release = resolve;
    });
    const running = runProductionDaemon(
      ["--config", "/etc/agentport/agentport.json"],
      { ...fixture.value, readConfiguration: () => configurationPending },
    );
    await vi.waitFor(() => {
      expect(fixture.signalListeners.has("SIGTERM")).toBe(true);
    });
    fixture.signalListeners.get("SIGTERM")?.();
    release?.(configuration);
    await running;
    expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.stop).not.toHaveBeenCalled();
  });

  it("propagates bounded shutdown while startup remains pending", async () => {
    const fixture = dependencies();
    const startup = new Promise<void>(() => undefined);
    const start = vi.fn(() => startup);
    fixture.value.createLifecycle = () => ({
      state: "starting",
      start,
      stop: () =>
        Promise.reject(new DaemonLifecycleError(DAEMON_SHUTDOWN_FAILED)),
    });
    const running = runProductionDaemon(
      ["--config", "/etc/agentport/agentport.json"],
      fixture.value,
    );
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalled();
    });
    fixture.signalListeners.get("SIGTERM")?.();
    await expect(running).rejects.toMatchObject({
      code: DAEMON_SHUTDOWN_FAILED,
    });
  });

  it("projects an unknown cause as one sanitized stable code", async () => {
    const fixture = dependencies();
    const exitCode = await daemonMain(
      ["--config", "/etc/agentport/agentport.json"],
      {
        ...fixture.value,
        readConfiguration: () =>
          Promise.reject(new Error("raw-secret-and-path-sentinel")),
      },
    );
    expect(exitCode).toBe(1);
    expect(fixture.errors).toEqual([
      JSON.stringify({ code: "daemon_startup_failed" }),
    ]);
    expect(fixture.errors.join()).not.toContain("raw-secret-and-path-sentinel");
  });
});
