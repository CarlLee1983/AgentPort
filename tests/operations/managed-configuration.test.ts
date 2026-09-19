import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AgentRegistry } from "../../src/bootstrap/registry.js";
import { parseDaemonConfiguration } from "../../src/daemon/configuration.js";
import {
  addManagedAgent,
  addManagedCaller,
  addManagedPrincipal,
  listManagedAgents,
  listManagedCallers,
  readManagedConfiguration,
  removeManagedAgent,
  revokeManagedCaller,
  updateManagedConfiguration,
  ManagedConfigurationError,
} from "../../src/operations/managed-configuration.js";
import {
  hashCallerToken,
  isCallerTokenHash,
} from "../../src/security/caller-token.js";

async function fixture(): Promise<{
  root: string;
  configPath: string;
  workspace: string;
}> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agentport-managed-")),
  );
  const workspaceRoot = join(root, "workspaces");
  await mkdir(workspaceRoot, { mode: 0o700 });
  const workspace = join(workspaceRoot, "project-a");
  await mkdir(workspace, { mode: 0o700 });
  const configPath = join(root, "agentport.json");
  await writeFile(
    configPath,
    `${JSON.stringify({
      schemaVersion: 1,
      workspaceRoot,
      mcp: { port: 3333 },
      storage: { databasePath: join(root, "agentport.sqlite") },
      launcher: {
        socketPath: join(root, "launcher.sock"),
        workerIngressDirectory: join(root, "ingress"),
        socketGroupId: 10001,
        runtimeGroupId: 10002,
        ingressGroupId: 10003,
      },
      adminSocket: { groupId: 10004 },
      agents: [],
      principals: [],
      callers: [],
    })}\n`,
    { mode: 0o640 },
  );
  return { root, configPath, workspace };
}

describe("managed project and Caller configuration", () => {
  it("adds a project, principal and one-shot Caller token without persisting raw token", async () => {
    const test = await fixture();
    try {
      await updateManagedConfiguration(test.configPath, (document) =>
        addManagedAgent(document, {
          agentId: "project-a",
          description: "Hub Station project A",
          workspacePath: test.workspace,
          configurationRevision: "v1",
          runtimeDriver: "claude-code",
          runtimeVersion: "configured",
          launchProfileId: "project-a",
          maximumExecutionLimitSeconds: 3_600,
          maximumInputWaitSeconds: 86_400,
        }),
      );
      await updateManagedConfiguration(test.configPath, (document) =>
        addManagedPrincipal(document, {
          principalId: "hub-caller",
          accessScopeId: "hub-scope",
          allowedAgentIds: ["project-a"],
        }),
      );
      let token: string | undefined;
      await updateManagedConfiguration(test.configPath, (document) => {
        const result = addManagedCaller(document, "hub-station", "hub-caller");
        token = result.token;
        return result.document;
      });
      expect(token).toMatch(/^ap_[A-Za-z0-9_-]{43}$/u);
      const raw = await readFile(test.configPath, "utf8");
      expect(raw).not.toContain(token as string);
      expect(raw).toContain(hashCallerToken(token as string));
      const { document } = await readManagedConfiguration(test.configPath);
      expect(listManagedAgents(document)).toMatchObject([
        { agentId: "project-a" },
      ]);
      expect(listManagedCallers(document)).toEqual([
        { callerId: "hub-station", principalId: "hub-caller", active: true },
      ]);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("authenticates a hashed Caller and revocation takes effect on replacement", async () => {
    const test = await fixture();
    try {
      const document = addManagedPrincipal(
        addManagedAgent(
          {
            schemaVersion: 1,
            workspaceRoot: join(test.root, "workspaces"),
            mcp: { port: 3333 },
            storage: { databasePath: join(test.root, "agentport.sqlite") },
            launcher: {
              socketPath: join(test.root, "launcher.sock"),
              workerIngressDirectory: join(test.root, "ingress"),
              socketGroupId: 10001,
              runtimeGroupId: 10002,
              ingressGroupId: 10003,
            },
            adminSocket: { groupId: 10004 },
            agents: [],
            principals: [],
            callers: [],
          },
          {
            agentId: "project-a",
            description: "project",
            workspacePath: test.workspace,
            configurationRevision: "v1",
            runtimeDriver: "claude-code",
            runtimeVersion: "configured",
            launchProfileId: "project-a",
            maximumExecutionLimitSeconds: 3_600,
            maximumInputWaitSeconds: 86_400,
          },
        ),
        {
          principalId: "hub-caller",
          accessScopeId: "hub-scope",
          allowedAgentIds: ["project-a"],
        },
      );
      const added = addManagedCaller(document, "hub-station", "hub-caller");
      const parsed = parseDaemonConfiguration(added.document);
      const revisionFence = {
        installRegistryRevision: () => Promise.resolve(),
      };
      const registry = await AgentRegistry.create(
        {
          credentials: {},
          callers: parsed.callers ?? [],
          agents: parsed.agents,
          principals: parsed.principals,
        },
        revisionFence,
      );
      expect(isCallerTokenHash(parsed.callers?.[0]?.tokenHash ?? "")).toBe(
        true,
      );
      expect(registry.authenticate(added.token)).toBe("hub-caller");

      const revokedDocument = revokeManagedCaller(
        added.document,
        "hub-station",
      );
      const revoked = parseDaemonConfiguration(revokedDocument);
      await registry.replace({
        credentials: {},
        callers: revoked.callers ?? [],
        agents: revoked.agents,
        principals: revoked.principals,
      });
      expect(registry.authenticate(added.token)).toBeUndefined();
      expect(revoked.callers?.[0]?.active).toBe(false);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("refuses to remove a project still allowed by a Principal", () => {
    const document = {
      agents: [{ agentId: "project-a" }],
      principals: [
        { principalId: "hub-caller", allowedAgentIds: ["project-a"] },
      ],
      callers: [],
    };
    expect(() => removeManagedAgent(document, "project-a")).toThrow(
      new ManagedConfigurationError("managed_agent_referenced"),
    );
  });

  it("rejects a contended configuration update instead of losing an earlier write", async () => {
    const test = await fixture();
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const first = updateManagedConfiguration(
        test.configPath,
        async (document) => {
          entered?.();
          await hold;
          return addManagedPrincipal(document, {
            principalId: "first",
            accessScopeId: "first-scope",
            allowedAgentIds: [],
          });
        },
      );
      await enteredPromise;
      await expect(
        updateManagedConfiguration(test.configPath, (document) =>
          addManagedPrincipal(document, {
            principalId: "second",
            accessScopeId: "second-scope",
            allowedAgentIds: [],
          }),
        ),
      ).rejects.toMatchObject({ code: "managed_configuration_conflict" });
      release?.();
      await first;
      const { parsed } = await readManagedConfiguration(test.configPath);
      expect(parsed.principals.map(({ principalId }) => principalId)).toEqual([
        "first",
      ]);
    } finally {
      release?.();
      await rm(test.root, { recursive: true, force: true });
    }
  });
});
