import { spawnSync } from "node:child_process";
import { access, lstat } from "node:fs/promises";
import { join } from "node:path";

async function main() {
  const { isClaudeSubscriptionAuthStatus } = await import(
    "../dist/src/runtime/claude/auth-policy.js"
  );
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new Error("invalid-host");
  }
  if (
    process.env.AGENTPORT_G1_CLAUDE !== "1" ||
    process.env.AGENTPORT_G1_LINUX !== "1"
  ) {
    throw new Error("disabled");
  }
  for (const name of [
    "AGENTPORT_G1_CLAUDE_EXECUTABLE",
    "AGENTPORT_G1_CLAUDE_WORKSPACE",
    "AGENTPORT_G1_LAUNCHER_SOCKET",
    "AGENTPORT_G1_RUNTIME_HOME",
    "AGENTPORT_G1_RUNTIME_GID",
    "AGENTPORT_G1_RUNTIME_UID",
    "AGENTPORT_G1_RUNTIME_USER",
  ]) {
    if (!process.env[name]) throw new Error("missing-configuration");
  }

  const runtimeUser = process.env.AGENTPORT_G1_RUNTIME_USER;
  const runtimeHome = process.env.AGENTPORT_G1_RUNTIME_HOME;
  const runtimeUid = Number(process.env.AGENTPORT_G1_RUNTIME_UID);
  const runtimeGid = Number(process.env.AGENTPORT_G1_RUNTIME_GID);
  const claudeExecutable = process.env.AGENTPORT_G1_CLAUDE_EXECUTABLE;
  const claudeConfigDirectory = join(runtimeHome, ".claude");
  const credentialPath = join(claudeConfigDirectory, ".credentials.json");
  await Promise.all([
    access(process.env.AGENTPORT_G1_CLAUDE_WORKSPACE),
    access(process.env.AGENTPORT_G1_LAUNCHER_SOCKET),
    access(claudeExecutable),
  ]);
  const [homeMetadata, configMetadata, credentialMetadata] = await Promise.all([
    lstat(runtimeHome),
    lstat(claudeConfigDirectory),
    lstat(credentialPath),
  ]);
  if (
    !Number.isSafeInteger(runtimeUid) ||
    !Number.isSafeInteger(runtimeGid) ||
    !homeMetadata.isDirectory() ||
    !configMetadata.isDirectory() ||
    !credentialMetadata.isFile() ||
    homeMetadata.uid !== runtimeUid ||
    homeMetadata.gid !== runtimeGid ||
    configMetadata.uid !== runtimeUid ||
    configMetadata.gid !== runtimeGid ||
    credentialMetadata.uid !== runtimeUid ||
    credentialMetadata.gid !== runtimeGid ||
    (homeMetadata.mode & 0o777) !== 0o700 ||
    (configMetadata.mode & 0o077) !== 0 ||
    (credentialMetadata.mode & 0o077) !== 0
  ) {
    throw new Error("unprotected-credential-source");
  }

  const auth = spawnSync(
    "/usr/sbin/runuser",
    [
      "-u",
      runtimeUser,
      "--",
      "/usr/bin/env",
      "-i",
      `HOME=${runtimeHome}`,
      `CLAUDE_CONFIG_DIR=${claudeConfigDirectory}`,
      "PATH=/usr/local/bin:/usr/bin:/bin",
      claudeExecutable,
      "auth",
      "status",
    ],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 },
  );
  if (auth.error) throw new Error("auth-probe-failed");
  let status;
  try {
    status = JSON.parse(auth.stdout);
  } catch {
    throw new Error("invalid-auth-status");
  }
  if (auth.status !== 0 || !isClaudeSubscriptionAuthStatus(status)) {
    throw new Error("wrong-auth-source");
  }
  process.stdout.write("G1_CLAUDE_PREFLIGHT_OK\n");
}

void main().catch(() => {
  process.stderr.write("G1_CLAUDE_PREFLIGHT_FAILED\n");
  process.exitCode = 1;
});
