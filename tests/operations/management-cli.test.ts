import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  manage,
  managementErrorCode,
} from "../../src/operations/manage-main.js";

async function fixture(): Promise<{
  root: string;
  config: string;
  workspaceRoot: string;
  workspace: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentport-cli-")));
  const workspaceRoot = join(root, "workspaces");
  await mkdir(workspaceRoot, { mode: 0o700 });
  const workspace = join(workspaceRoot, "project-a");
  await mkdir(workspace, { mode: 0o700 });
  const config = join(root, "agentport.json");
  await writeFile(
    config,
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
  return { root, config, workspaceRoot, workspace };
}

describe("AgentPort management CLI", () => {
  it("registers a project and one-shot Caller without exposing a verifier", async () => {
    const test = await fixture();
    try {
      await expect(
        manage([
          "agent",
          "add",
          "--config",
          test.config,
          "--agent-id",
          "project-a",
          "--description",
          "Project A",
          "--workspace",
          test.workspace,
          "--launch-profile",
          "project-a",
        ]),
      ).resolves.toMatchObject({ command: "agent_add", agentId: "project-a" });
      await manage([
        "principal",
        "add",
        "--config",
        test.config,
        "--principal-id",
        "hub-operator",
        "--access-scope-id",
        "hub-scope",
        "--allow-agent",
        "project-a",
      ]);
      const added = await manage([
        "caller",
        "add",
        "--config",
        test.config,
        "--caller-id",
        "hub-mcp",
        "--principal-id",
        "hub-operator",
      ]);
      expect(added).toMatchObject({
        command: "caller_add",
        callerId: "hub-mcp",
        principalId: "hub-operator",
      });
      const token = String(added.token);
      expect(token).toMatch(/^ap_[A-Za-z0-9_-]{43}$/u);
      const persisted = await readFile(test.config, "utf8");
      expect(persisted).not.toContain(token);
      expect(await manage(["caller", "list", "--config", test.config])).toEqual(
        {
          version: 1,
          command: "caller_list",
          registryRevision: 4,
          callers: [
            { callerId: "hub-mcp", principalId: "hub-operator", active: true },
          ],
        },
      );
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("refuses a missing or overlapping Workspace without changing config", async () => {
    const test = await fixture();
    try {
      await expect(
        manage([
          "agent",
          "add",
          "--config",
          test.config,
          "--agent-id",
          "missing",
          "--description",
          "Missing",
          "--workspace",
          join(test.root, "does-not-exist"),
          "--launch-profile",
          "missing",
        ]),
      ).rejects.toMatchObject({ code: "managed_agent_workspace_invalid" });
      const before = await readFile(test.config, "utf8");
      await manage([
        "agent",
        "add",
        "--config",
        test.config,
        "--agent-id",
        "project-a",
        "--description",
        "Project A",
        "--workspace",
        test.workspace,
        "--launch-profile",
        "project-a",
      ]);
      await expect(
        manage([
          "agent",
          "add",
          "--config",
          test.config,
          "--agent-id",
          "nested",
          "--description",
          "Nested",
          "--workspace",
          test.workspace,
          "--launch-profile",
          "nested",
        ]),
      ).rejects.toMatchObject({ code: "managed_agent_workspace_conflict" });
      expect(await readFile(test.config, "utf8")).not.toBe(before);
      const errorCode = managementErrorCode(
        new Error("private raw cause must not be projected"),
      );
      expect(errorCode).toBe("management_unavailable");
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("keeps Agent Workspaces inside the approved root with safe metadata", async () => {
    const test = await fixture();
    try {
      const outside = join(test.root, "outside");
      await mkdir(outside, { mode: 0o700 });
      await expect(
        manage([
          "agent",
          "add",
          "--config",
          test.config,
          "--agent-id",
          "outside",
          "--description",
          "Outside",
          "--workspace",
          outside,
          "--launch-profile",
          "outside",
        ]),
      ).rejects.toMatchObject({ code: "managed_agent_workspace_invalid" });

      await expect(
        manage([
          "agent",
          "add",
          "--config",
          test.config,
          "--agent-id",
          "root",
          "--description",
          "Root",
          "--workspace",
          test.workspaceRoot,
          "--launch-profile",
          "root",
        ]),
      ).rejects.toMatchObject({ code: "managed_agent_workspace_invalid" });

      const unsafe = join(test.workspaceRoot, "unsafe");
      await mkdir(unsafe, { mode: 0o770 });
      await chmod(unsafe, 0o770);
      await expect(
        manage([
          "agent",
          "add",
          "--config",
          test.config,
          "--agent-id",
          "unsafe",
          "--description",
          "Unsafe",
          "--workspace",
          unsafe,
          "--launch-profile",
          "unsafe",
        ]),
      ).rejects.toMatchObject({ code: "managed_agent_workspace_invalid" });
      await chmod(unsafe, 0o700);

      const linkTarget = join(test.root, "link-target");
      await mkdir(linkTarget, { mode: 0o700 });
      const link = join(test.workspaceRoot, "link");
      await symlink(linkTarget, link);
      await expect(
        manage([
          "agent",
          "add",
          "--config",
          test.config,
          "--agent-id",
          "link",
          "--description",
          "Link",
          "--workspace",
          link,
          "--launch-profile",
          "link",
        ]),
      ).rejects.toMatchObject({ code: "managed_agent_workspace_invalid" });

      const protectedWorkspace = join(test.workspaceRoot, "protected");
      await mkdir(protectedWorkspace, { mode: 0o700 });
      const configured = JSON.parse(await readFile(test.config, "utf8")) as {
        storage: { databasePath: string };
      };
      configured.storage.databasePath = join(
        protectedWorkspace,
        "agentport.sqlite",
      );
      await writeFile(test.config, `${JSON.stringify(configured)}\n`);
      await expect(
        manage([
          "agent",
          "add",
          "--config",
          test.config,
          "--agent-id",
          "protected",
          "--description",
          "Protected",
          "--workspace",
          protectedWorkspace,
          "--launch-profile",
          "protected",
        ]),
      ).rejects.toMatchObject({ code: "managed_agent_workspace_invalid" });
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });
});
