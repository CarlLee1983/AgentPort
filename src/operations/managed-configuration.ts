import { constants } from "node:fs";
import { chmod, chown, lstat, open, rename, unlink } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
} from "node:path";
import { randomUUID } from "node:crypto";

import {
  parseDaemonConfiguration,
  type DaemonConfiguration,
} from "../daemon/configuration.js";
import {
  generateCallerToken,
  hashCallerToken,
} from "../security/caller-token.js";
import {
  ApprovedWorkspaceError,
  resolveApprovedWorkspace,
} from "../security/workspace.js";

export const MANAGED_CONFIGURATION_ERROR = "managed_configuration_invalid";

export type ManagedConfigurationErrorCode =
  | typeof MANAGED_CONFIGURATION_ERROR
  | "managed_configuration_io"
  | "managed_configuration_conflict"
  | "managed_agent_exists"
  | "managed_agent_referenced"
  | "managed_agent_not_found"
  | "managed_agent_workspace_invalid"
  | "managed_agent_workspace_conflict"
  | "managed_principal_exists"
  | "managed_principal_not_found"
  | "managed_caller_exists"
  | "managed_caller_not_found";

const MANAGED_AGENT_EXISTS = "managed_agent_exists" as const;
const MANAGED_AGENT_REFERENCED = "managed_agent_referenced" as const;
const MANAGED_AGENT_NOT_FOUND = "managed_agent_not_found" as const;
const MANAGED_AGENT_WORKSPACE_INVALID =
  "managed_agent_workspace_invalid" as const;
const MANAGED_AGENT_WORKSPACE_CONFLICT =
  "managed_agent_workspace_conflict" as const;
const MANAGED_PRINCIPAL_EXISTS = "managed_principal_exists" as const;
const MANAGED_PRINCIPAL_NOT_FOUND = "managed_principal_not_found" as const;
const MANAGED_CALLER_EXISTS = "managed_caller_exists" as const;
const MANAGED_CALLER_NOT_FOUND = "managed_caller_not_found" as const;
const MANAGED_CONFIGURATION_IO = "managed_configuration_io" as const;
const MANAGED_CONFIGURATION_CONFLICT =
  "managed_configuration_conflict" as const;

export class ManagedConfigurationError extends Error {
  constructor(readonly code: ManagedConfigurationErrorCode) {
    super(code);
    this.name = "ManagedConfigurationError";
  }
}

export type ManagedConfigurationDocument = Record<string, unknown>;

interface ConfigurationFileIdentity {
  dev: string;
  ino: string;
  size: number;
  mtimeMs: number;
}

export interface ManagedAgentInput {
  agentId: string;
  description: string;
  workspacePath: string;
  configurationRevision: string;
  runtimeDriver: string;
  runtimeVersion: string;
  launchProfileId: string;
  maximumExecutionLimitSeconds: number;
  maximumInputWaitSeconds: number;
}

export interface ManagedPrincipalInput {
  principalId: string;
  accessScopeId: string;
  allowedAgentIds: readonly string[];
}

function requireAbsoluteConfigurationPath(path: string): void {
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    basename(path) !== "agentport.json"
  ) {
    throw new ManagedConfigurationError(MANAGED_CONFIGURATION_ERROR);
  }
}

function asObject(value: unknown): ManagedConfigurationDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManagedConfigurationError(MANAGED_CONFIGURATION_ERROR);
  }
  return value as ManagedConfigurationDocument;
}

function asObjectArray(
  document: ManagedConfigurationDocument,
  key: "agents" | "principals" | "callers",
): ManagedConfigurationDocument[] {
  const value = document[key];
  if (value === undefined && key === "callers") return [];
  if (!Array.isArray(value)) {
    throw new ManagedConfigurationError(MANAGED_CONFIGURATION_ERROR);
  }
  return value.map(asObject);
}

function fileIdentity(
  metadata: Awaited<ReturnType<typeof lstat>>,
): ConfigurationFileIdentity {
  return {
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    size: Number(metadata.size),
    mtimeMs: Number(metadata.mtimeMs),
  };
}

function sameFileIdentity(
  left: ConfigurationFileIdentity,
  right: ConfigurationFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

async function readDocumentWithIdentity(path: string): Promise<{
  document: ManagedConfigurationDocument;
  identity: ConfigurationFileIdentity;
}> {
  requireAbsoluteConfigurationPath(path);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size === 0 ||
      metadata.size > 128 * 1024
    ) {
      throw new ManagedConfigurationError(MANAGED_CONFIGURATION_ERROR);
    }
    const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
    const document = asObject(parsed);
    const parsedConfiguration = parseDaemonConfiguration(document);
    document.registryRevision ??= parsedConfiguration.registryRevision ?? 1;
    document.workspaceRoot ??= parsedConfiguration.workspaceRoot;
    return { document, identity: fileIdentity(metadata) };
  } catch (error) {
    if (error instanceof ManagedConfigurationError) throw error;
    throw new ManagedConfigurationError(MANAGED_CONFIGURATION_IO);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readDocument(
  path: string,
): Promise<ManagedConfigurationDocument> {
  return (await readDocumentWithIdentity(path)).document;
}

async function writeAtomic(
  path: string,
  document: ManagedConfigurationDocument,
  expectedIdentity?: ConfigurationFileIdentity,
): Promise<void> {
  requireAbsoluteConfigurationPath(path);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new ManagedConfigurationError(MANAGED_CONFIGURATION_IO);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ManagedConfigurationError(MANAGED_CONFIGURATION_ERROR);
  }
  if (
    expectedIdentity !== undefined &&
    !sameFileIdentity(expectedIdentity, fileIdentity(metadata))
  ) {
    throw new ManagedConfigurationError(MANAGED_CONFIGURATION_CONFLICT);
  }
  const directory = dirname(path);
  const temporary = join(directory, `.agentport-config-${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      metadata.mode & 0o777,
    );
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, metadata.mode & 0o777);
    if (process.getuid?.() === 0) {
      await chown(temporary, metadata.uid, metadata.gid);
    }
    await rename(temporary, path);
    const directoryHandle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (error instanceof ManagedConfigurationError) throw error;
    throw new ManagedConfigurationError(MANAGED_CONFIGURATION_IO);
  }
}

async function withConfigurationLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${path}.lock`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let acquired = false;
  try {
    handle = await open(
      lockPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    acquired = true;
    await handle.writeFile(`${String(process.pid)}\n`, "utf8");
    await handle.sync();
    return await operation();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new ManagedConfigurationError(MANAGED_CONFIGURATION_CONFLICT);
    }
    if (error instanceof ManagedConfigurationError) throw error;
    throw new ManagedConfigurationError(MANAGED_CONFIGURATION_IO);
  } finally {
    await handle?.close().catch(() => undefined);
    if (acquired) await unlink(lockPath).catch(() => undefined);
  }
}

function pathContains(parent: string, child: string): boolean {
  const nested = relative(parent, child);
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
}

/** Validates an administrator-provided Workspace without changing its layout. */
export async function validateManagedAgentWorkspace(
  document: ManagedConfigurationDocument,
  workspacePath: string,
): Promise<void> {
  const workspaceRoot: unknown = document.workspaceRoot;
  if (typeof workspaceRoot !== "string") {
    throw new ManagedConfigurationError(MANAGED_AGENT_WORKSPACE_INVALID);
  }
  try {
    const resolution = await resolveApprovedWorkspace(
      workspaceRoot,
      workspacePath,
    );
    const requestedPath = normalize(workspacePath);
    for (const pathValue of [
      document.storage &&
      typeof document.storage === "object" &&
      !Array.isArray(document.storage)
        ? (document.storage as Record<string, unknown>).databasePath
        : undefined,
      document.launcher &&
      typeof document.launcher === "object" &&
      !Array.isArray(document.launcher)
        ? (document.launcher as Record<string, unknown>).workerIngressDirectory
        : undefined,
    ]) {
      if (typeof pathValue === "string") {
        const protectedPath = normalize(pathValue);
        if (
          pathContains(resolution.canonicalPath, protectedPath) ||
          pathContains(protectedPath, resolution.canonicalPath) ||
          pathContains(requestedPath, protectedPath) ||
          pathContains(protectedPath, requestedPath)
        ) {
          throw new ManagedConfigurationError(MANAGED_AGENT_WORKSPACE_INVALID);
        }
      }
    }
    const canonicalPath = resolution.canonicalPath;
    for (const agent of asObjectArray(document, "agents")) {
      if (typeof agent.workspacePath !== "string") continue;
      let existing;
      try {
        existing = await resolveApprovedWorkspace(
          workspaceRoot,
          agent.workspacePath,
        );
      } catch (error) {
        if (error instanceof ApprovedWorkspaceError) {
          throw new ManagedConfigurationError(MANAGED_AGENT_WORKSPACE_INVALID);
        }
        throw error;
      }
      if (
        pathContains(existing.canonicalPath, canonicalPath) ||
        pathContains(canonicalPath, existing.canonicalPath)
      ) {
        throw new ManagedConfigurationError(MANAGED_AGENT_WORKSPACE_CONFLICT);
      }
    }
  } catch (error) {
    if (error instanceof ManagedConfigurationError) throw error;
    if (error instanceof ApprovedWorkspaceError) {
      throw new ManagedConfigurationError(MANAGED_AGENT_WORKSPACE_INVALID);
    }
    throw new ManagedConfigurationError(MANAGED_AGENT_WORKSPACE_INVALID);
  }
}

export async function updateManagedConfiguration(
  path: string,
  update: (
    document: ManagedConfigurationDocument,
  ) => ManagedConfigurationDocument | Promise<ManagedConfigurationDocument>,
): Promise<DaemonConfiguration> {
  requireAbsoluteConfigurationPath(path);
  return withConfigurationLock(path, async () => {
    const { document: current, identity } =
      await readDocumentWithIdentity(path);
    const cloned = asObject(JSON.parse(JSON.stringify(current)) as unknown);
    const currentRevision =
      typeof cloned.registryRevision === "number" &&
      Number.isSafeInteger(cloned.registryRevision) &&
      cloned.registryRevision > 0
        ? cloned.registryRevision
        : 1;
    const next = asObject(await update(cloned));
    const nextRevision = currentRevision + 1;
    if (!Number.isSafeInteger(nextRevision)) {
      throw new ManagedConfigurationError(MANAGED_CONFIGURATION_CONFLICT);
    }
    next.registryRevision = nextRevision;
    try {
      const parsed = parseDaemonConfiguration(next);
      await writeAtomic(path, next, identity);
      return parsed;
    } catch (error) {
      if (error instanceof ManagedConfigurationError) throw error;
      throw new ManagedConfigurationError(MANAGED_CONFIGURATION_ERROR);
    }
  });
}

export async function readManagedConfiguration(path: string): Promise<{
  document: ManagedConfigurationDocument;
  parsed: DaemonConfiguration;
}> {
  const document = await readDocument(path);
  return { document, parsed: parseDaemonConfiguration(document) };
}

export function addManagedAgent(
  document: ManagedConfigurationDocument,
  input: ManagedAgentInput,
): ManagedConfigurationDocument {
  const agents = asObjectArray(document, "agents");
  if (agents.some((agent) => agent.agentId === input.agentId)) {
    throw new ManagedConfigurationError(MANAGED_AGENT_EXISTS);
  }
  return {
    ...document,
    agents: [
      ...agents,
      {
        agentId: input.agentId,
        description: input.description,
        workspacePath: input.workspacePath,
        configurationRevision: input.configurationRevision,
        runtimeDriver: input.runtimeDriver,
        runtimeVersion: input.runtimeVersion,
        launchProfileId: input.launchProfileId,
        policy: {
          maximumExecutionLimitSeconds: input.maximumExecutionLimitSeconds,
          maximumInputWaitSeconds: input.maximumInputWaitSeconds,
        },
      },
    ],
  };
}

export function removeManagedAgent(
  document: ManagedConfigurationDocument,
  agentId: string,
): ManagedConfigurationDocument {
  const agents = asObjectArray(document, "agents");
  if (!agents.some((agent) => agent.agentId === agentId)) {
    throw new ManagedConfigurationError(MANAGED_AGENT_NOT_FOUND);
  }
  const principals = asObjectArray(document, "principals");
  if (
    principals.some(
      (principal) =>
        Array.isArray(principal.allowedAgentIds) &&
        principal.allowedAgentIds.includes(agentId),
    )
  ) {
    throw new ManagedConfigurationError(MANAGED_AGENT_REFERENCED);
  }
  return {
    ...document,
    agents: agents.filter((agent) => agent.agentId !== agentId),
  };
}

export function addManagedPrincipal(
  document: ManagedConfigurationDocument,
  input: ManagedPrincipalInput,
): ManagedConfigurationDocument {
  const principals = asObjectArray(document, "principals");
  if (
    principals.some((principal) => principal.principalId === input.principalId)
  ) {
    throw new ManagedConfigurationError(MANAGED_PRINCIPAL_EXISTS);
  }
  return {
    ...document,
    principals: [
      ...principals,
      {
        principalId: input.principalId,
        accessScopeId: input.accessScopeId,
        active: true,
        allowedAgentIds: [...input.allowedAgentIds],
      },
    ],
  };
}

export function removeManagedPrincipal(
  document: ManagedConfigurationDocument,
  principalId: string,
): ManagedConfigurationDocument {
  const principals = asObjectArray(document, "principals");
  if (!principals.some((principal) => principal.principalId === principalId)) {
    throw new ManagedConfigurationError(MANAGED_PRINCIPAL_NOT_FOUND);
  }
  const callers = asObjectArray(document, "callers");
  if (callers.some((caller) => caller.principalId === principalId)) {
    throw new ManagedConfigurationError(MANAGED_CONFIGURATION_CONFLICT);
  }
  return {
    ...document,
    principals: principals.filter(
      (principal) => principal.principalId !== principalId,
    ),
  };
}

export function addManagedCaller(
  document: ManagedConfigurationDocument,
  callerId: string,
  principalId: string,
): { document: ManagedConfigurationDocument; token: string } {
  const principals = asObjectArray(document, "principals");
  if (!principals.some((principal) => principal.principalId === principalId)) {
    throw new ManagedConfigurationError(MANAGED_PRINCIPAL_NOT_FOUND);
  }
  const callers = asObjectArray(document, "callers");
  if (callers.some((caller) => caller.callerId === callerId)) {
    throw new ManagedConfigurationError(MANAGED_CALLER_EXISTS);
  }
  const token = generateCallerToken();
  return {
    document: {
      ...document,
      callers: [
        ...callers,
        {
          callerId,
          principalId,
          tokenHash: hashCallerToken(token),
          active: true,
        },
      ],
    },
    token,
  };
}

export function revokeManagedCaller(
  document: ManagedConfigurationDocument,
  callerId: string,
): ManagedConfigurationDocument {
  const callers = asObjectArray(document, "callers");
  if (!callers.some((caller) => caller.callerId === callerId)) {
    throw new ManagedConfigurationError(MANAGED_CALLER_NOT_FOUND);
  }
  return {
    ...document,
    callers: callers.map((caller) =>
      caller.callerId === callerId ? { ...caller, active: false } : caller,
    ),
  };
}

export function listManagedAgents(
  document: ManagedConfigurationDocument,
): ManagedConfigurationDocument[] {
  return asObjectArray(document, "agents").map((agent) => ({
    agentId: agent.agentId,
    description: agent.description,
    configurationRevision: agent.configurationRevision,
    policy: agent.policy,
  }));
}

export function listManagedPrincipals(
  document: ManagedConfigurationDocument,
): ManagedConfigurationDocument[] {
  return asObjectArray(document, "principals").map((principal) => ({
    principalId: principal.principalId,
    accessScopeId: principal.accessScopeId,
    active: principal.active,
    allowedAgentIds: principal.allowedAgentIds,
  }));
}

export function listManagedCallers(
  document: ManagedConfigurationDocument,
): ManagedConfigurationDocument[] {
  return asObjectArray(document, "callers").map((caller) => ({
    callerId: caller.callerId,
    principalId: caller.principalId,
    active: caller.active,
  }));
}
