import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
  MAX_AGENT_DESCRIPTION_BYTES,
  MAX_IDENTIFIER_CHARACTERS,
  type AgentDescriptor,
  type AgentPolicy,
  type WorkspaceIdentity,
} from "../core/types.js";

export type { AgentPolicy, WorkspaceIdentity } from "../core/types.js";

export interface AgentConfiguration {
  agentId: string;
  description: string;
  workspacePath: string;
  configurationRevision: string;
  runtimeDriver: string;
  runtimeVersion: string;
  launchProfileId: string;
  policy: AgentPolicy;
}

export interface PrincipalConfiguration {
  principalId: string;
  accessScopeId: string;
  active: boolean;
  allowedAgentIds: readonly string[];
}

export interface RegistryConfiguration {
  credentials: Readonly<Record<string, string>>;
  principals: readonly PrincipalConfiguration[];
  agents: readonly AgentConfiguration[];
}

export interface ResolvedAgentBinding {
  descriptor: AgentDescriptor;
  configurationRevision: string;
  workspace: WorkspaceIdentity;
  runtimeDriver: string;
  runtimeVersion: string;
  launchProfileId: string;
  policy: AgentPolicy;
}

export interface PrincipalAuthorization {
  principalId: string;
  accessScopeId: string;
  registryRevision?: number;
  allowedAgentIds: ReadonlySet<string>;
  getAgent(agentId: string): ResolvedAgentBinding | undefined;
  listAgents(): ResolvedAgentBinding[];
}

export interface RegistryRevisionFence {
  installRegistryRevision(revision: number): Promise<void>;
}

interface RegistrySnapshot {
  credentials: ReadonlyMap<string, string>;
  principals: ReadonlyMap<string, PrincipalConfiguration>;
  agents: ReadonlyMap<string, ResolvedAgentBinding>;
}

function includesPath(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent))
  );
}

function compareIdentifier(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

async function resolveAgent(
  configuration: AgentConfiguration,
): Promise<ResolvedAgentBinding> {
  if (
    configuration.agentId.length === 0 ||
    configuration.agentId.length > MAX_IDENTIFIER_CHARACTERS
  ) {
    throw new Error("Configured Agent ID is outside the supported bounds");
  }
  if (
    configuration.launchProfileId.length === 0 ||
    configuration.launchProfileId.length > MAX_IDENTIFIER_CHARACTERS ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(configuration.launchProfileId)
  ) {
    throw new Error(
      `Configured launch profile is outside the supported bounds: ${configuration.agentId}`,
    );
  }
  if (
    Buffer.byteLength(configuration.description, "utf8") >
    MAX_AGENT_DESCRIPTION_BYTES
  ) {
    throw new Error(
      "Configured Agent description is outside the supported bounds",
    );
  }
  const canonicalPath = await realpath(resolve(configuration.workspacePath));
  const workspaceStat = await stat(canonicalPath);
  if (!workspaceStat.isDirectory()) {
    throw new Error(
      `Configured Workspace is not a directory: ${configuration.agentId}`,
    );
  }
  if (
    !isPositiveSafeInteger(configuration.policy.maximumExecutionLimitSeconds) ||
    !isPositiveSafeInteger(configuration.policy.maximumInputWaitSeconds)
  ) {
    throw new Error(
      `Configured Agent policy bounds must be positive: ${configuration.agentId}`,
    );
  }

  return {
    descriptor: {
      agentId: configuration.agentId,
      description: configuration.description,
      availability: "available",
      capabilities: ["durable_admission", "queued_cancellation"],
    },
    configurationRevision: configuration.configurationRevision,
    workspace: {
      canonicalPath,
      filesystemIdentity: `${String(workspaceStat.dev)}:${String(workspaceStat.ino)}`,
    },
    runtimeDriver: configuration.runtimeDriver,
    runtimeVersion: configuration.runtimeVersion,
    launchProfileId: configuration.launchProfileId,
    policy: { ...configuration.policy },
  };
}

async function buildSnapshot(
  configuration: RegistryConfiguration,
): Promise<RegistrySnapshot> {
  const agents = new Map<string, ResolvedAgentBinding>();
  for (const agentConfiguration of configuration.agents) {
    if (agents.has(agentConfiguration.agentId)) {
      throw new Error(`Duplicate Agent ID: ${agentConfiguration.agentId}`);
    }
    const resolvedAgent = await resolveAgent(agentConfiguration);
    for (const existing of agents.values()) {
      if (
        existing.workspace.filesystemIdentity ===
          resolvedAgent.workspace.filesystemIdentity ||
        includesPath(
          existing.workspace.canonicalPath,
          resolvedAgent.workspace.canonicalPath,
        ) ||
        includesPath(
          resolvedAgent.workspace.canonicalPath,
          existing.workspace.canonicalPath,
        )
      ) {
        throw new Error(
          `Overlapping Workspace configuration: ${agentConfiguration.agentId}`,
        );
      }
    }
    agents.set(agentConfiguration.agentId, resolvedAgent);
  }

  const principals = new Map<string, PrincipalConfiguration>();
  for (const principal of configuration.principals) {
    if (
      principal.principalId.length === 0 ||
      principal.principalId.length > MAX_IDENTIFIER_CHARACTERS ||
      principal.accessScopeId.length === 0 ||
      principal.accessScopeId.length > MAX_IDENTIFIER_CHARACTERS
    ) {
      throw new Error("Principal ID and Access Scope ID must be nonempty");
    }
    if (principals.has(principal.principalId)) {
      throw new Error(`Duplicate Principal ID: ${principal.principalId}`);
    }
    for (const agentId of principal.allowedAgentIds) {
      if (!agents.has(agentId)) {
        throw new Error(
          `Principal ${principal.principalId} allows unknown Agent ${agentId}`,
        );
      }
    }
    principals.set(principal.principalId, {
      ...principal,
      allowedAgentIds: [...principal.allowedAgentIds],
    });
  }

  const credentials = new Map<string, string>();
  for (const [token, principalId] of Object.entries(
    configuration.credentials,
  )) {
    if (token.length === 0 || credentials.has(token)) {
      throw new Error("Credential tokens must be nonempty and unique");
    }
    if (!principals.has(principalId)) {
      throw new Error(`Credential maps to unknown Principal ${principalId}`);
    }
    credentials.set(token, principalId);
  }

  return { agents, credentials, principals };
}

export class AgentRegistry {
  readonly #revisionFence: RegistryRevisionFence;
  #revision = 1;
  #mutationFenceAvailable = true;
  #replacementTail: Promise<void> = Promise.resolve();

  private constructor(
    private snapshot: RegistrySnapshot,
    revisionFence: RegistryRevisionFence,
  ) {
    this.#revisionFence = revisionFence;
  }

  static async create(
    configuration: RegistryConfiguration,
    revisionFence: RegistryRevisionFence,
  ): Promise<AgentRegistry> {
    const registry = new AgentRegistry(
      await buildSnapshot(configuration),
      revisionFence,
    );
    await revisionFence.installRegistryRevision(registry.#revision);
    return registry;
  }

  async replace(configuration: RegistryConfiguration): Promise<void> {
    const replacement = this.#replacementTail.then(async () => {
      const next = await buildSnapshot(configuration);
      const nextRevision = this.#revision + 1;
      try {
        await this.#revisionFence.installRegistryRevision(nextRevision);
      } catch (error) {
        this.#mutationFenceAvailable = false;
        throw error;
      }
      this.snapshot = next;
      this.#revision = nextRevision;
      this.#mutationFenceAvailable = true;
    });
    this.#replacementTail = replacement.catch(() => undefined);
    await replacement;
  }

  async waitForPendingReplacement(): Promise<void> {
    await this.#replacementTail;
  }

  authenticate(token: string): string | undefined {
    return this.snapshot.credentials.get(token);
  }

  authorize(principalId: string): PrincipalAuthorization | undefined {
    const current = this.snapshot;
    const principal = current.principals.get(principalId);
    if (principal === undefined || !principal.active) return undefined;
    const allowedAgentIds = new Set(principal.allowedAgentIds);
    return {
      principalId,
      accessScopeId: principal.accessScopeId,
      ...(this.#mutationFenceAvailable
        ? { registryRevision: this.#revision }
        : {}),
      allowedAgentIds,
      getAgent: (agentId) => {
        if (!allowedAgentIds.has(agentId)) return undefined;
        return current.agents.get(agentId);
      },
      listAgents: () =>
        [...current.agents.values()]
          .filter(({ descriptor }) => allowedAgentIds.has(descriptor.agentId))
          .sort((left, right) =>
            compareIdentifier(
              left.descriptor.agentId,
              right.descriptor.agentId,
            ),
          ),
    };
  }
}
