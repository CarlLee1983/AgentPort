import { describe, expect, it, vi } from "vitest";

import type { DaemonConfiguration } from "../../src/daemon/configuration.js";
import {
  doctor,
  DoctorError,
  type DoctorDependencies,
} from "../../src/operations/doctor.js";

const configuration: DaemonConfiguration = {
  mcp: { port: 3333 },
  storage: { databasePath: "/var/lib/agentport/daemon/agentport.sqlite" },
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

function metadata(input: {
  socket?: boolean;
  directory?: boolean;
  uid?: number;
  gid?: number;
  mode?: number;
}) {
  return {
    isSocket: () => input.socket === true,
    isDirectory: () => input.directory === true,
    isSymbolicLink: () => false,
    uid: input.uid ?? 0,
    gid: input.gid ?? 0,
    mode: input.mode ?? 0,
  } as ReturnType<DoctorDependencies["lstat"]> extends Promise<infer Value>
    ? Value
    : never;
}

function fixture() {
  const readLauncher = vi.fn(() =>
    Promise.resolve({
      socketPath: "/run/agentport/launcher.sock",
      socketGroup: "agentport-launcher",
      ledgerDirectory: "/var/lib/agentport/launcher",
      workspaceRoot: "/var/agentport/workspaces",
      runtimeUser: "agentport-runtime",
      runtimeGroup: "agentport-runtime",
      runtimeHome: "/var/lib/agentport/runtime-home",
      nodeExecutable: "/usr/bin/node",
      ingressDirectory: "/run/agentport-ingress",
      ingressGroup: "agentport-ingress",
      profiles: {},
    }),
  );
  const liveHealth = vi.fn(() => Promise.resolve(true));
  const readConfiguration = vi.fn(() => Promise.resolve(configuration));
  const dependencies: DoctorDependencies = {
    getUid: () => 0,
    now: () => "2026-09-18T12:34:56.789Z",
    readConfiguration,
    groupId: vi.fn((group: string) => {
      if (group === "agentport-daemon") return Promise.resolve(1000);
      if (group === "agentport-launcher") return Promise.resolve(1001);
      return Promise.reject(new Error("unknown group"));
    }),
    readLauncher,
    lstat: vi.fn((path: string) => {
      if (path === "/run/agentport/launcher.sock") {
        return Promise.resolve(
          metadata({ socket: true, gid: 1001, mode: 0o660 }),
        );
      }
      if (path === "/run/agentport") {
        return Promise.resolve(
          metadata({ directory: true, gid: 1000, mode: 0o1771 }),
        );
      }
      return Promise.resolve(
        metadata({ directory: true, gid: 1003, mode: 0o771 }),
      );
    }),
    liveHealth,
  };
  return { dependencies, readConfiguration, readLauncher, liveHealth };
}

describe("deployment readiness doctor", () => {
  it("performs only offline protected-layout checks by default", async () => {
    const { dependencies, readConfiguration, readLauncher, liveHealth } =
      fixture();

    await expect(
      doctor(["--config", "/etc/agentport/agentport.json"], dependencies),
    ).resolves.toEqual({
      version: 1,
      readiness: {
        level: "installed",
        reason: "service-unavailable",
        observedAt: "2026-09-18T12:34:56.789Z",
        capabilities: {
          service: "unavailable",
          agents: "none",
          launcher: "ready",
          runtime: "unverified",
          callerProvisioning: "absent",
          protectedTopology: "valid",
        },
      },
    });
    expect(readLauncher).toHaveBeenCalledWith("/etc/agentport/launcher.json");
    expect(readConfiguration).toHaveBeenCalledWith(
      "/etc/agentport/agentport.json",
      1000,
    );
    expect(liveHealth).not.toHaveBeenCalled();
  });

  it("runs exactly the explicit live Runtime health seam", async () => {
    const { dependencies, liveHealth } = fixture();

    const result = await doctor(
      ["--config", "/etc/agentport/agentport.json", "--live"],
      dependencies,
    );

    expect(result.readiness.capabilities.runtime).toBe("verified");
    expect(liveHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeUser: "agentport-runtime",
        runtimeHome: "/var/lib/agentport/runtime-home",
        nodeExecutable: "/usr/bin/node",
      }),
    );
  });

  it("projects an unreadable protected configuration without exposing its cause", async () => {
    const { dependencies } = fixture();
    dependencies.readConfiguration = vi.fn(() =>
      Promise.reject(new Error("credential-marker /protected/path")),
    );

    const result = await doctor(
      ["--config", "/etc/agentport/agentport.json"],
      dependencies,
    );
    expect(result.version).toBe(1);
    expect(result.readiness.level).toBe("installed");
    expect(result.readiness.reason).toBe("observation-unavailable");
    expect(result.readiness.observedAt).toBeNull();
  });

  it("rejects unapproved arguments and non-administrator invocation", async () => {
    const { dependencies } = fixture();
    await expect(doctor(["--live"], dependencies)).rejects.toEqual(
      new DoctorError("doctor_arguments_invalid"),
    );
    dependencies.getUid = () => 995;
    await expect(
      doctor(["--config", "/etc/agentport/agentport.json"], dependencies),
    ).rejects.toEqual(new DoctorError("doctor_forbidden"));
  });

  it("fails closed when the administrator group can reach the launcher socket", async () => {
    const { dependencies } = fixture();
    dependencies.groupId = vi.fn((group: string) =>
      Promise.resolve(group === "agentport-daemon" ? 1000 : 1004),
    );

    const result = await doctor(
      ["--config", "/etc/agentport/agentport.json"],
      dependencies,
    );

    expect(result.readiness.capabilities.protectedTopology).toBe("invalid");
    expect(result.readiness.level).toBe("installed");
  });
});
