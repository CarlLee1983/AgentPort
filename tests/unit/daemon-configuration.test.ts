import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DAEMON_CONFIGURATION_ERROR,
  parseDaemonConfiguration,
  readProtectedDaemonConfiguration,
} from "../../src/daemon/configuration.js";

const configuration = {
  schemaVersion: 1,
  mcp: {},
  storage: { databasePath: "/var/lib/agentport/agentport.sqlite" },
  launcher: {
    socketPath: "/run/agentport/launcher.sock",
    workerIngressDirectory: "/run/agentport/ingress",
    socketGroupId: 987,
    runtimeGroupId: 988,
    ingressGroupId: 989,
  },
  adminSocket: { groupId: 990 },
  agents: [
    {
      agentId: "primary",
      description: "Primary Agent",
      workspacePath: "/srv/agentport/primary",
      configurationRevision: "v1",
      runtimeDriver: "claude",
      runtimeVersion: "1",
      launchProfileId: "primary",
      policy: {
        maximumExecutionLimitSeconds: 3600,
        maximumInputWaitSeconds: 86_400,
      },
    },
  ],
  principals: [
    {
      principalId: "operator",
      accessScopeId: "default",
      active: true,
      allowedAgentIds: ["primary"],
    },
  ],
};

describe("production daemon configuration", () => {
  it("defaults to the fixed loopback port and keeps credentials out of production configuration", () => {
    const parsed = parseDaemonConfiguration(configuration);
    expect(parsed.mcp.port).toBe(3333);
    expect(parsed.registryRevision).toBe(1);
    expect(parsed.workspaceRoot).toBe("/var/agentport/workspaces");
    expect(parsed.agents).toEqual(configuration.agents);
    expect(parsed.principals).toEqual(configuration.principals);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    ["unsupported schema", { ...configuration, schemaVersion: 2 }],
    ["invalid Registry revision", { ...configuration, registryRevision: 0 }],
    [
      "fractional Registry revision",
      { ...configuration, registryRevision: 1.5 },
    ],
    [
      "raw credential map",
      { ...configuration, credentials: { token: "operator" } },
    ],
    ["unknown field", { ...configuration, unexpected: true }],
    [
      "relative database",
      { ...configuration, storage: { databasePath: "db.sqlite" } },
    ],
    ["port zero", { ...configuration, mcp: { port: 0 } }],
    ["invalid port", { ...configuration, mcp: { port: 65_536 } }],
    ["invalid admin socket group", { ...configuration, adminSocket: {} }],
    [
      "Runtime-authorized admin socket group",
      { ...configuration, adminSocket: { groupId: 988 } },
    ],
    [
      "launcher-authorized admin socket group",
      { ...configuration, adminSocket: { groupId: 987 } },
    ],
    [
      "ingress-authorized admin socket group",
      { ...configuration, adminSocket: { groupId: 989 } },
    ],
    [
      "unknown Agent mapping",
      {
        ...configuration,
        principals: [
          { ...configuration.principals[0], allowedAgentIds: ["missing"] },
        ],
      },
    ],
    [
      "overlapping runtime groups",
      {
        ...configuration,
        launcher: { ...configuration.launcher, ingressGroupId: 988 },
      },
    ],
    [
      "storage control reserve below its contract",
      {
        ...configuration,
        storage: {
          databasePath: "/var/lib/agentport/agentport.sqlite",
          taskControlReserveBytes: 1,
        },
      },
    ],
  ])("rejects %s with a stable sanitized code", (_label, value) => {
    expect(() => parseDaemonConfiguration(value)).toThrow(
      DAEMON_CONFIGURATION_ERROR,
    );
  });

  it("rejects unsafe file metadata without repairing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentport-config-"));
    const path = join(directory, "agentport.json");
    try {
      await writeFile(path, JSON.stringify(configuration), { mode: 0o660 });
      await chmod(path, 0o660);
      await expect(readProtectedDaemonConfiguration(path)).rejects.toThrow(
        DAEMON_CONFIGURATION_ERROR,
      );
      expect((await readFile(path, "utf8")).length).toBeGreaterThan(0);
      const { mode } = await stat(path);
      expect(mode & 0o777).toBe(0o660);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
