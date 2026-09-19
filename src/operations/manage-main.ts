import {
  addManagedAgent,
  addManagedCaller,
  addManagedPrincipal,
  listManagedAgents,
  listManagedCallers,
  listManagedPrincipals,
  ManagedConfigurationError,
  readManagedConfiguration,
  removeManagedAgent,
  removeManagedPrincipal,
  revokeManagedCaller,
  updateManagedConfiguration,
  validateManagedAgentWorkspace,
  type ManagedAgentInput,
} from "./managed-configuration.js";

export class ManagementCliError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ManagementCliError";
  }
}

function flag(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  if (index === -1) return undefined;
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ManagementCliError("management_arguments_invalid");
  }
  return value;
}

function requiredFlag(arguments_: readonly string[], name: string): string {
  const value = flag(arguments_, name);
  if (value === undefined) {
    throw new ManagementCliError("management_arguments_invalid");
  }
  return value;
}

function repeatedFlag(arguments_: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === name) {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ManagementCliError("management_arguments_invalid");
      }
      values.push(value);
      index += 1;
    }
  }
  return values;
}

function positiveFlag(
  arguments_: readonly string[],
  name: string,
  fallback: number,
): number {
  const raw = flag(arguments_, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ManagementCliError("management_arguments_invalid");
  }
  return value;
}

function requireNoUnknownFlags(
  arguments_: readonly string[],
  allowed: readonly string[],
): void {
  for (const argument of arguments_) {
    if (argument.startsWith("--") && !allowed.includes(argument)) {
      throw new ManagementCliError("management_arguments_invalid");
    }
  }
}

function configPath(arguments_: readonly string[]): string {
  return requiredFlag(arguments_, "--config");
}

async function agentCommand(
  action: string,
  arguments_: readonly string[],
): Promise<Record<string, unknown>> {
  const path = configPath(arguments_);
  if (action === "list") {
    requireNoUnknownFlags(arguments_, ["--config"]);
    const { document, parsed } = await readManagedConfiguration(path);
    return {
      version: 1,
      command: "agent_list",
      registryRevision: parsed.registryRevision,
      agents: listManagedAgents(document),
    };
  }
  if (action === "remove") {
    requireNoUnknownFlags(arguments_, ["--config", "--agent-id"]);
    const agentId = requiredFlag(arguments_, "--agent-id");
    await updateManagedConfiguration(path, (document) =>
      removeManagedAgent(document, agentId),
    );
    return { version: 1, command: "agent_remove", agentId };
  }
  if (action !== "add") {
    throw new ManagementCliError("management_arguments_invalid");
  }
  requireNoUnknownFlags(arguments_, [
    "--config",
    "--agent-id",
    "--description",
    "--workspace",
    "--configuration-revision",
    "--runtime-driver",
    "--runtime-version",
    "--launch-profile",
    "--execution-limit-seconds",
    "--input-wait-seconds",
  ]);
  const input: ManagedAgentInput = {
    agentId: requiredFlag(arguments_, "--agent-id"),
    description: requiredFlag(arguments_, "--description"),
    workspacePath: requiredFlag(arguments_, "--workspace"),
    configurationRevision: flag(arguments_, "--configuration-revision") ?? "v1",
    runtimeDriver: flag(arguments_, "--runtime-driver") ?? "claude-code",
    runtimeVersion: flag(arguments_, "--runtime-version") ?? "configured",
    launchProfileId: requiredFlag(arguments_, "--launch-profile"),
    maximumExecutionLimitSeconds: positiveFlag(
      arguments_,
      "--execution-limit-seconds",
      3_600,
    ),
    maximumInputWaitSeconds: positiveFlag(
      arguments_,
      "--input-wait-seconds",
      86_400,
    ),
  };
  await updateManagedConfiguration(path, async (document) => {
    await validateManagedAgentWorkspace(document, input.workspacePath);
    return addManagedAgent(document, input);
  });
  return { version: 1, command: "agent_add", agentId: input.agentId };
}

async function principalCommand(
  action: string,
  arguments_: readonly string[],
): Promise<Record<string, unknown>> {
  const path = configPath(arguments_);
  if (action === "list") {
    requireNoUnknownFlags(arguments_, ["--config"]);
    const { document, parsed } = await readManagedConfiguration(path);
    return {
      version: 1,
      command: "principal_list",
      registryRevision: parsed.registryRevision,
      principals: listManagedPrincipals(document),
    };
  }
  if (action === "remove") {
    requireNoUnknownFlags(arguments_, ["--config", "--principal-id"]);
    const principalId = requiredFlag(arguments_, "--principal-id");
    await updateManagedConfiguration(path, (document) =>
      removeManagedPrincipal(document, principalId),
    );
    return { version: 1, command: "principal_remove", principalId };
  }
  if (action !== "add") {
    throw new ManagementCliError("management_arguments_invalid");
  }
  requireNoUnknownFlags(arguments_, [
    "--config",
    "--principal-id",
    "--access-scope-id",
    "--allow-agent",
  ]);
  const principalId = requiredFlag(arguments_, "--principal-id");
  const accessScopeId = requiredFlag(arguments_, "--access-scope-id");
  const allowedAgentIds = repeatedFlag(arguments_, "--allow-agent");
  await updateManagedConfiguration(path, (document) =>
    addManagedPrincipal(document, {
      principalId,
      accessScopeId,
      allowedAgentIds,
    }),
  );
  return { version: 1, command: "principal_add", principalId };
}

async function callerCommand(
  action: string,
  arguments_: readonly string[],
): Promise<Record<string, unknown>> {
  const path = configPath(arguments_);
  if (action === "list") {
    requireNoUnknownFlags(arguments_, ["--config"]);
    const { document, parsed } = await readManagedConfiguration(path);
    return {
      version: 1,
      command: "caller_list",
      registryRevision: parsed.registryRevision,
      callers: listManagedCallers(document),
    };
  }
  if (action === "revoke") {
    requireNoUnknownFlags(arguments_, ["--config", "--caller-id"]);
    const callerId = requiredFlag(arguments_, "--caller-id");
    await updateManagedConfiguration(path, (document) =>
      revokeManagedCaller(document, callerId),
    );
    return { version: 1, command: "caller_revoke", callerId };
  }
  if (action !== "add") {
    throw new ManagementCliError("management_arguments_invalid");
  }
  requireNoUnknownFlags(arguments_, [
    "--config",
    "--caller-id",
    "--principal-id",
  ]);
  const callerId = requiredFlag(arguments_, "--caller-id");
  const principalId = requiredFlag(arguments_, "--principal-id");
  let token: string | undefined;
  await updateManagedConfiguration(path, (document) => {
    const result = addManagedCaller(document, callerId, principalId);
    token = result.token;
    return result.document;
  });
  if (token === undefined)
    throw new ManagementCliError("management_unavailable");
  return { version: 1, command: "caller_add", callerId, principalId, token };
}

export async function manage(
  arguments_: readonly string[],
): Promise<Record<string, unknown>> {
  const [resource, action, ...rest] = arguments_;
  if (resource === "agent") return agentCommand(action ?? "", rest);
  if (resource === "principal") return principalCommand(action ?? "", rest);
  if (resource === "caller") return callerCommand(action ?? "", rest);
  throw new ManagementCliError("management_arguments_invalid");
}

export function managementErrorCode(error: unknown): string {
  return error instanceof ManagementCliError ||
    error instanceof ManagedConfigurationError
    ? error.code
    : "management_unavailable";
}
