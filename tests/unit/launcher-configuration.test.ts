import { describe, expect, it, vi } from "vitest";

import { ensureLauncherIngressDirectory } from "../../src/supervisor/linux/ingress-directory.js";
import { parseLinuxLauncherOptions } from "../../src/supervisor/linux/launcher-configuration.js";
import { isPrivilegeSeparatedRuntimeIdentity } from "../../src/supervisor/linux/launcher-server.js";

const validConfiguration = {
  socketPath: "/run/agentport-g1/launcher.sock",
  socketGroup: "agentport-supervisor",
  ledgerDirectory: "/var/lib/agentport-g1/ledger",
  workspaceRoot: "/srv/agentport/workspaces",
  runtimeUser: "agentport-runtime",
  runtimeGroup: "agentport-runtime",
  runtimeHome: "/var/lib/agentport-runtime",
  nodeExecutable: "/usr/local/bin/node",
  ingressDirectory: "/run/agentport-g1-ingress",
  ingressGroup: "agentport-ingress",
  profiles: {
    "g1-idle": {
      workspaceIdentity: "g1-workspace",
      workspacePath: "/srv/agentport/workspaces/g1",
      workerEntrypoint: "/opt/agentport-g1/current/worker.js",
      workerArguments: ["--mode", "idle"],
      memoryMaxBytes: 536_870_912,
      tasksMax: 64,
      cpuQuotaPercent: 100,
    },
  },
  commandTimeoutMilliseconds: 5000,
  stopTimeoutMilliseconds: 5000,
};

describe("protected Linux launcher configuration", () => {
  it("accepts and freezes the complete bounded configuration", () => {
    const parsed = parseLinuxLauncherOptions(validConfiguration);
    expect(parsed).toEqual(validConfiguration);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.profiles)).toBe(true);
    expect(Object.isFrozen(parsed.profiles["g1-idle"])).toBe(true);
    expect(Object.isFrozen(parsed.profiles["g1-idle"]?.workerArguments)).toBe(
      true,
    );
  });

  it.each([
    ["unknown root field", { ...validConfiguration, unexpected: true }],
    [
      "unknown profile field",
      {
        ...validConfiguration,
        profiles: {
          "g1-idle": {
            ...validConfiguration.profiles["g1-idle"],
            unexpected: true,
          },
        },
      },
    ],
    ["relative socket", { ...validConfiguration, socketPath: "launcher.sock" }],
    ["empty profiles", { ...validConfiguration, profiles: {} }],
    [
      "unbounded worker argument",
      {
        ...validConfiguration,
        profiles: {
          "g1-idle": {
            ...validConfiguration.profiles["g1-idle"],
            workerArguments: ["x".repeat(4097)],
          },
        },
      },
    ],
    [
      "invalid resource bound",
      {
        ...validConfiguration,
        profiles: {
          "g1-idle": {
            ...validConfiguration.profiles["g1-idle"],
            tasksMax: 0,
          },
        },
      },
    ],
  ])("rejects %s", (_label, configuration) => {
    expect(() => parseLinuxLauncherOptions(configuration)).toThrow(
      "Invalid protected launcher configuration",
    );
  });

  it.each([
    [
      "ingressGroup equals socketGroup",
      { ...validConfiguration, ingressGroup: validConfiguration.socketGroup },
    ],
    [
      "ingressGroup equals runtimeGroup",
      { ...validConfiguration, ingressGroup: validConfiguration.runtimeGroup },
    ],
  ])("rejects %s", (_label, configuration) => {
    expect(() => parseLinuxLauncherOptions(configuration)).toThrow(
      "Invalid protected launcher configuration",
    );
  });
});

describe("launcher ingress directory security fixture (AP-021)", () => {
  it("rejects /run/agentport/ingress symlinked to /tmp before creating anything", async () => {
    const configuration = parseLinuxLauncherOptions({
      ...validConfiguration,
      ingressDirectory: "/run/agentport/ingress",
    });
    expect(configuration.ingressDirectory).toBe("/run/agentport/ingress");
    const create = vi.fn(() => Promise.resolve());
    await expect(
      ensureLauncherIngressDirectory(
        989,
        () =>
          Promise.resolve({
            processUid: 0,
            // lstat of the configured path reports the symlink itself.
            target: {
              isDirectory: false,
              isSymbolicLink: true,
              uid: 0,
              gid: 0,
              mode: 0o777,
            },
            ancestors: [
              {
                path: "/run/agentport",
                isDirectory: true,
                isSymbolicLink: false,
                uid: 0,
                mode: 0o750,
              },
              {
                path: "/run",
                isDirectory: true,
                isSymbolicLink: false,
                uid: 0,
                mode: 0o755,
              },
              {
                path: "/",
                isDirectory: true,
                isSymbolicLink: false,
                uid: 0,
                mode: 0o755,
              },
            ],
          }),
        create,
      ),
    ).rejects.toThrow("Launcher ingress directory is not protected");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("Linux Runtime identity group separation", () => {
  it("accepts only the dedicated primary Runtime group", () => {
    expect(isPrivilegeSeparatedRuntimeIdentity(997, 989, 990, [989])).toBe(
      true,
    );
  });

  it.each([
    ["root user", 0, 989, 990, [989]],
    ["root primary group", 997, 0, 990, [0]],
    ["launcher socket group", 997, 989, 990, [989, 990]],
    ["root supplementary group", 997, 989, 990, [989, 0]],
    ["another supplementary group", 997, 989, 990, [989, 991]],
  ])("rejects %s", (_label, uid, gid, socketGid, groups) => {
    expect(
      isPrivilegeSeparatedRuntimeIdentity(uid, gid, socketGid, groups),
    ).toBe(false);
  });
});
