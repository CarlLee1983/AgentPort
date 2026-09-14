function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const G1_CLAUDE_HARNESS_VARIABLES = [
  "AGENTPORT_G1_CLAUDE",
  "AGENTPORT_G1_CANDIDATE_REVISION",
  "AGENTPORT_G1_CLAUDE_EXECUTABLE",
  "AGENTPORT_G1_CLAUDE_WORKSPACE",
  "AGENTPORT_G1_CORE_DATA_PATH",
  "AGENTPORT_G1_LAUNCHER_CONFIG",
  "AGENTPORT_G1_LAUNCHER_SERVICE",
  "AGENTPORT_G1_LAUNCHER_SOCKET",
  "AGENTPORT_G1_LEDGER_DIRECTORY",
  "AGENTPORT_G1_LINUX",
  "AGENTPORT_G1_RUNTIME_GID",
  "AGENTPORT_G1_RUNTIME_HOME",
  "AGENTPORT_G1_RUNTIME_UID",
  "AGENTPORT_G1_RUNTIME_USER",
  "AGENTPORT_G1_WORKSPACE_IDENTITY",
  "AGENTPORT_G1_WORKSPACE_PATH",
] as const;

export function createG1ClaudeHarnessEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const environment: Record<string, string> = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
  for (const name of G1_CLAUDE_HARNESS_VARIABLES) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export function isClaudeSubscriptionAuthStatus(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const subscriptionType = value["subscriptionType"];
  const apiKeySource = value["apiKeySource"];
  return (
    value["loggedIn"] === true &&
    value["authMethod"] === "claude.ai" &&
    value["apiProvider"] === "firstParty" &&
    typeof subscriptionType === "string" &&
    subscriptionType.length > 0 &&
    Buffer.byteLength(subscriptionType, "utf8") <= 64 &&
    apiKeySource === "none"
  );
}
