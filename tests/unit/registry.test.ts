import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentRegistry,
  type RegistryConfiguration,
} from "../../src/bootstrap/registry.js";

const directories: string[] = [];

async function workspace(name = "workspace"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentport-registry-"));
  directories.push(root);
  const path = join(root, name);
  await mkdir(path);
  return path;
}

function configuration(workspacePath: string): RegistryConfiguration {
  return {
    credentials: { "synthetic-token": "principal-a" },
    principals: [
      {
        principalId: "principal-a",
        accessScopeId: "scope-a",
        active: true,
        allowedAgentIds: ["agent-a"],
      },
    ],
    agents: [
      {
        agentId: "agent-a",
        description: "Agent A",
        workspacePath,
        configurationRevision: "config-1",
        runtimeDriver: "fixture-driver",
        runtimeVersion: "1.0.0",
        policy: {
          maximumExecutionLimitSeconds: 3600,
          maximumInputWaitSeconds: 86400,
        },
      },
    ],
  };
}

function createRegistry(configuration: RegistryConfiguration) {
  return AgentRegistry.create(configuration, {
    installRegistryRevision: () => Promise.resolve(),
  });
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("AgentRegistry", () => {
  it("installs monotonic mutation revisions only for validated snapshots", async () => {
    const workspacePath = await workspace();
    const config = configuration(workspacePath);
    const installed: number[] = [];
    const registry = await AgentRegistry.create(config, {
      installRegistryRevision: (revision) => {
        installed.push(revision);
        return Promise.resolve();
      },
    });
    expect(registry.authorize("principal-a")?.registryRevision).toBe(1);

    await registry.replace({
      ...config,
      agents: config.agents.map((agent) => ({
        ...agent,
        configurationRevision: "config-2",
      })),
    });
    expect(installed).toEqual([1, 2]);
    expect(registry.authorize("principal-a")?.registryRevision).toBe(2);

    const agent = config.agents[0];
    if (agent === undefined) throw new Error("Missing fixture Agent");
    await expect(
      registry.replace({
        ...config,
        agents: [
          {
            ...agent,
            policy: { ...agent.policy, maximumExecutionLimitSeconds: 0 },
          },
        ],
      }),
    ).rejects.toThrow("policy bounds must be positive");
    expect(installed).toEqual([1, 2]);
    expect(registry.authorize("principal-a")?.registryRevision).toBe(2);
  });

  it("keeps the previous readable snapshot and disables mutations after a fence failure", async () => {
    const workspacePath = await workspace();
    const config = configuration(workspacePath);
    const registry = await AgentRegistry.create(config, {
      installRegistryRevision: (revision) =>
        revision === 1
          ? Promise.resolve()
          : Promise.reject(new Error("injected fence failure")),
    });

    await expect(
      registry.replace({
        ...config,
        agents: config.agents.map((agent) => ({
          ...agent,
          description: "replacement must not become visible",
        })),
      }),
    ).rejects.toThrow("injected fence failure");
    const authorization = registry.authorize("principal-a");
    expect(authorization?.listAgents()[0]?.descriptor.description).toBe(
      "Agent A",
    );
    expect(authorization?.registryRevision).toBeUndefined();
  });

  it("separates credential identity from current membership and allowlist", async () => {
    const workspacePath = await workspace();
    const config = configuration(workspacePath);
    const principal = config.principals[0];
    if (principal === undefined)
      throw new Error("Fixture principal is missing");
    const registry = await createRegistry(config);

    expect(registry.authenticate("synthetic-token")).toBe("principal-a");
    const authorization = registry.authorize("principal-a");
    expect(authorization).toMatchObject({
      principalId: "principal-a",
      accessScopeId: "scope-a",
    });
    expect(authorization?.listAgents()[0]?.descriptor).toEqual({
      agentId: "agent-a",
      description: "Agent A",
      availability: "available",
      capabilities: ["durable_admission", "queued_cancellation"],
    });

    await registry.replace({
      ...config,
      principals: [{ ...principal, active: false }],
    });
    expect(registry.authenticate("synthetic-token")).toBe("principal-a");
    expect(registry.authorize("principal-a")).toBeUndefined();
  });

  it("rejects nested Workspace bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentport-registry-overlap-"));
    directories.push(root);
    const child = join(root, "child");
    await mkdir(child);
    const base = configuration(root);
    const agent = base.agents[0];
    const principal = base.principals[0];
    if (agent === undefined || principal === undefined) {
      throw new Error("Registry fixture is incomplete");
    }

    await expect(
      createRegistry({
        ...base,
        agents: [
          agent,
          {
            ...agent,
            agentId: "agent-b",
            workspacePath: child,
          },
        ],
        principals: [{ ...principal, allowedAgentIds: ["agent-a", "agent-b"] }],
      }),
    ).rejects.toThrow("Overlapping Workspace configuration");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unsafe Agent policy bound %s",
    async (bound) => {
      const workspacePath = await workspace();
      const config = configuration(workspacePath);
      const agent = config.agents[0];
      if (agent === undefined) throw new Error("Missing fixture Agent");
      await expect(
        createRegistry({
          ...config,
          agents: [
            {
              ...agent,
              policy: {
                ...agent.policy,
                maximumExecutionLimitSeconds: bound,
              },
            },
          ],
        }),
      ).rejects.toThrow("policy bounds must be positive");
    },
  );

  it("rejects Agent IDs that cannot be addressed through the public schema", async () => {
    const workspacePath = await workspace();
    const config = configuration(workspacePath);
    const agent = config.agents[0];
    const principal = config.principals[0];
    if (agent === undefined || principal === undefined) {
      throw new Error("Incomplete registry fixture");
    }
    const agentId = "a".repeat(129);
    await expect(
      createRegistry({
        ...config,
        agents: [{ ...agent, agentId }],
        principals: [{ ...principal, allowedAgentIds: [agentId] }],
      }),
    ).rejects.toThrow("Agent ID is outside the supported bounds");
  });

  it("bounds worst-case serialized Agent descriptions below the page limit", async () => {
    const workspacePath = await workspace();
    const config = configuration(workspacePath);
    const agent = config.agents[0];
    if (agent === undefined) throw new Error("Missing fixture Agent");
    await expect(
      createRegistry({
        ...config,
        agents: [{ ...agent, description: "\0".repeat(8 * 1024 + 1) }],
      }),
    ).rejects.toThrow("description is outside the supported bounds");
    const worstCasePage = {
      ok: true,
      agents: Array.from({ length: 100 }, (_, index) => ({
        agentId: `agent-${String(index)}`,
        description: "\0".repeat(8 * 1024),
        availability: "available",
        capabilities: ["durable_admission", "queued_cancellation"],
      })),
      nextCursor: null,
    };
    expect(Buffer.byteLength(JSON.stringify(worstCasePage))).toBeLessThan(
      8 * 1024 * 1024,
    );
  });
});
