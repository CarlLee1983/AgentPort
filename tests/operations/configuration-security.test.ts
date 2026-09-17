import { describe, expect, it, vi } from "vitest";

import { preflightLinuxOperations } from "../../src/operations/linux-preflight.js";
import { parseLinuxLauncherOptions } from "../../src/supervisor/linux/launcher-configuration.js";

const configuration = {
  launcherConfigurationPath: "/etc/agentport/launcher.json",
  daemonUser: "agentport-daemon",
  databasePath: "/var/lib/agentport/store.db",
};

const launcher = parseLinuxLauncherOptions({
  socketPath: "/run/agentport/launcher.sock",
  socketGroup: "agentport-launcher",
  ledgerDirectory: "/var/lib/agentport-ledger",
  workspaceRoot: "/srv/agentport/workspaces",
  runtimeUser: "agentport-runtime",
  runtimeGroup: "agentport-runtime",
  runtimeHome: "/var/lib/agentport-runtime",
  nodeExecutable: "/usr/bin/node",
  ingressDirectory: "/run/agentport-ingress",
  ingressGroup: "agentport-ingress",
  profiles: {
    idle: {
      workspaceIdentity: "idle",
      workspacePath: "/srv/agentport/workspaces/idle",
      workerEntrypoint: "/opt/agentport/worker.js",
      workerArguments: [],
    },
  },
});

type Metadata = {
  kind: "directory" | "file" | "socket" | "symlink" | "other";
  uid: number;
  gid: number;
  mode: number;
};

function validDependencies() {
  const paths = new Map<string, Metadata>([
    ["/", { kind: "directory", uid: 0, gid: 0, mode: 0o755 }],
    ["/var", { kind: "directory", uid: 0, gid: 0, mode: 0o755 }],
    ["/var/lib", { kind: "directory", uid: 0, gid: 0, mode: 0o755 }],
    [
      "/var/lib/agentport",
      { kind: "directory", uid: 995, gid: 990, mode: 0o700 },
    ],
    [
      "/var/lib/agentport-ledger",
      { kind: "directory", uid: 0, gid: 0, mode: 0o700 },
    ],
    ["/run", { kind: "directory", uid: 0, gid: 0, mode: 0o755 }],
    ["/run/agentport", { kind: "directory", uid: 0, gid: 990, mode: 0o750 }],
    [
      "/run/agentport-ingress",
      { kind: "directory", uid: 0, gid: 989, mode: 0o771 },
    ],
  ]);
  const effectiveAccess = new Set<string>();
  const canonicalAliases = new Map<string, string>();
  return {
    paths,
    effectiveAccess,
    canonicalAliases,
    dependencies: {
      platform: "linux",
      uid: 0,
      readLauncher: vi.fn(() => Promise.resolve(launcher)),
      account: vi.fn((name: string) =>
        Promise.resolve(
          name === "agentport-daemon"
            ? { uid: 995, gid: 990, groups: [990, 989, 988] }
            : { uid: 997, gid: 988, groups: [988] },
        ),
      ),
      group: vi.fn((name: string) =>
        Promise.resolve(
          name === "agentport-launcher"
            ? 990
            : name === "agentport-runtime"
              ? 988
              : 989,
        ),
      ),
      metadata: vi.fn((path: string) => Promise.resolve(paths.get(path))),
      canonical: vi.fn((path: string) =>
        Promise.resolve(canonicalAliases.get(path) ?? path),
      ),
      runtimeAccess: vi.fn((path: string, _user: string, permission: string) =>
        Promise.resolve(effectiveAccess.has(`${path}:${permission}`)),
      ),
    },
  };
}

describe("Linux administrator configuration preflight", () => {
  it("checks the separate daemon and Runtime identities without claiming dispatch readiness", async () => {
    const { dependencies } = validDependencies();
    const result = await preflightLinuxOperations(configuration, dependencies);
    expect(result.status).toBe("preparation_valid");
    expect(result.dispatchEligible).toBe(false);
    expect(result.checks).toContainEqual({
      code: "identity_separation",
      outcome: "pass",
    });
    expect(result.checks).toContainEqual({
      code: "database_permissions",
      outcome: "pass",
    });
    expect(result.checks).toContainEqual({
      code: "broker_provisioning",
      outcome: "not_assessed",
    });
    expect(result.checks).toContainEqual({
      code: "https_proxy",
      outcome: "not_assessed",
    });
  });

  it.each([
    [
      "Runtime joins launcher socket group",
      "identity_separation",
      (fixture: ReturnType<typeof validDependencies>) => {
        fixture.dependencies.account = vi.fn((name: string) =>
          Promise.resolve(
            name === "agentport-daemon"
              ? { uid: 995, gid: 990, groups: [990, 989, 988] }
              : { uid: 997, gid: 988, groups: [988, 990] },
          ),
        );
      },
    ],
    [
      "daemon is not a member of the Runtime group",
      "identity_separation",
      (fixture: ReturnType<typeof validDependencies>) => {
        fixture.dependencies.account = vi.fn((name: string) =>
          Promise.resolve(
            name === "agentport-daemon"
              ? { uid: 995, gid: 990, groups: [990, 989] }
              : { uid: 997, gid: 988, groups: [988] },
          ),
        );
      },
    ],
    [
      "Runtime user is a member of the ingress group",
      "identity_separation",
      (fixture: ReturnType<typeof validDependencies>) => {
        fixture.dependencies.account = vi.fn((name: string) =>
          Promise.resolve(
            name === "agentport-daemon"
              ? { uid: 995, gid: 990, groups: [990, 989, 988] }
              : { uid: 997, gid: 988, groups: [988, 989] },
          ),
        );
      },
    ],
    [
      "daemon is not a member of the ingress group",
      "identity_separation",
      (fixture: ReturnType<typeof validDependencies>) => {
        fixture.dependencies.account = vi.fn((name: string) =>
          Promise.resolve(
            name === "agentport-daemon"
              ? { uid: 995, gid: 990, groups: [990, 988] }
              : { uid: 997, gid: 988, groups: [988] },
          ),
        );
      },
    ],
    [
      "database parent is a symlink",
      "database_permissions",
      (fixture: ReturnType<typeof validDependencies>) => {
        fixture.paths.set("/var/lib/agentport", {
          kind: "symlink",
          uid: 995,
          gid: 990,
          mode: 0o700,
        });
      },
    ],
    [
      "Runtime can write the database parent",
      "database_permissions",
      (fixture: ReturnType<typeof validDependencies>) => {
        fixture.paths.set("/var/lib/agentport", {
          kind: "directory",
          uid: 995,
          gid: 988,
          mode: 0o770,
        });
      },
    ],
    [
      "daemon cannot write an existing database",
      "database_permissions",
      (fixture: ReturnType<typeof validDependencies>) => {
        fixture.paths.set("/var/lib/agentport/store.db", {
          kind: "file",
          uid: 0,
          gid: 0,
          mode: 0o600,
        });
      },
    ],
    [
      "Runtime ACL grants database-parent traverse and write",
      "database_permissions",
      (fixture: ReturnType<typeof validDependencies>) => {
        fixture.effectiveAccess.add("/var/lib/agentport:write");
        fixture.effectiveAccess.add("/var/lib/agentport:traverse");
      },
    ],
    [
      "Runtime ACL grants WAL write",
      "database_permissions",
      (fixture: ReturnType<typeof validDependencies>) => {
        fixture.paths.set("/var/lib/agentport/store.db-wal", {
          kind: "file",
          uid: 995,
          gid: 990,
          mode: 0o600,
        });
        fixture.effectiveAccess.add("/var/lib/agentport/store.db-wal:write");
      },
    ],
    [
      "Runtime ACL grants launcher socket write",
      "launcher_control_paths",
      (fixture: ReturnType<typeof validDependencies>) => {
        fixture.paths.set("/run/agentport/launcher.sock", {
          kind: "socket",
          uid: 0,
          gid: 990,
          mode: 0o660,
        });
        fixture.effectiveAccess.add("/run/agentport/launcher.sock:write");
      },
    ],
    [
      "worker ingress is group writable",
      "worker_ingress_path",
      (fixture: ReturnType<typeof validDependencies>) => {
        fixture.paths.set("/run/agentport-ingress", {
          kind: "directory",
          uid: 0,
          gid: 989,
          mode: 0o770,
        });
      },
    ],
    [
      "worker ingress is the superseded root:runtimeGroup 0750 layout",
      "worker_ingress_path",
      (fixture: ReturnType<typeof validDependencies>) => {
        fixture.paths.set("/run/agentport-ingress", {
          kind: "directory",
          uid: 0,
          gid: 988,
          mode: 0o750,
        });
      },
    ],
  ])("rejects %s with a sanitized %s check", async (_label, code, change) => {
    const fixture = validDependencies();
    change(fixture);
    const result = await preflightLinuxOperations(
      configuration,
      fixture.dependencies,
    );
    expect(result.status).toBe("configuration_invalid");
    expect(result.dispatchEligible).toBe(false);
    expect(result.checks).toContainEqual({ code, outcome: "fail" });
  });

  it("rejects a database beneath the Runtime home", async () => {
    const { dependencies } = validDependencies();
    const result = await preflightLinuxOperations(
      { ...configuration, databasePath: "/var/lib/agentport-runtime/store.db" },
      dependencies,
    );
    expect(result.checks).toContainEqual({
      code: "database_scope",
      outcome: "fail",
    });
    expect(result.dispatchEligible).toBe(false);
  });

  it("uses the canonical Workspace root when checking database overlap", async () => {
    const fixture = validDependencies();
    fixture.canonicalAliases.set("/srv/agentport/workspaces", "/var/lib");
    const result = await preflightLinuxOperations(
      configuration,
      fixture.dependencies,
    );
    expect(result.checks).toContainEqual({
      code: "database_scope",
      outcome: "fail",
    });
    expect(result.dispatchEligible).toBe(false);
  });

  it("rejects path traversal before protected launcher access", async () => {
    const { dependencies } = validDependencies();
    const result = await preflightLinuxOperations(
      { ...configuration, databasePath: "/var/lib/agentport/../store.db" },
      dependencies,
    );
    expect(result.checks).toContainEqual({
      code: "configuration_fields",
      outcome: "fail",
    });
    expect(dependencies.readLauncher).not.toHaveBeenCalled();
  });

  it("never emits private path or lookup details on an inspection failure", async () => {
    const { dependencies } = validDependencies();
    dependencies.metadata = vi.fn(() =>
      Promise.reject(
        new Error("PRIVATE /var/lib/agentport/store.db bearer-value"),
      ),
    );
    const result = await preflightLinuxOperations(configuration, dependencies);
    expect(result.status).toBe("configuration_invalid");
    expect(result.checks).toContainEqual({
      code: "path_inspection",
      outcome: "fail",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE|store\.db|bearer-value/u,
    );
  });

  it("fails closed when the effective Runtime access probe cannot start", async () => {
    const { dependencies } = validDependencies();
    dependencies.runtimeAccess = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error("runuser PAM session failed"), { code: 1 }),
      ),
    );
    const result = await preflightLinuxOperations(configuration, dependencies);
    expect(result.status).toBe("configuration_invalid");
    expect(result.checks).toContainEqual({
      code: "path_inspection",
      outcome: "fail",
    });
    expect(JSON.stringify(result)).not.toContain("PAM");
  });

  it("refuses unsupported platforms without touching protected configuration", async () => {
    const { dependencies } = validDependencies();
    dependencies.platform = "darwin";
    const result = await preflightLinuxOperations(configuration, dependencies);
    expect(result.status).toBe("unsupported_platform");
    expect(result.dispatchEligible).toBe(false);
    expect(dependencies.readLauncher).not.toHaveBeenCalled();
  });
});
