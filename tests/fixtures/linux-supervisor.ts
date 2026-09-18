import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { access, lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ExecutionReference } from "../../src/core/types.js";
import { LinuxExecutionSupervisor } from "../../src/supervisor/linux/execution-supervisor.js";
import { LinuxLauncherClient } from "../../src/supervisor/linux/launcher-client.js";
import { executionLedgerKey } from "../../src/supervisor/linux/launcher-protocol.js";

const executeFile = promisify(execFile);

export const LINUX_G1_ENABLED =
  process.platform === "linux" && process.env["AGENTPORT_G1_LINUX"] === "1";

interface NonRootResponse<T> {
  uid: number;
  result: T;
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the Linux G1 suite`);
  }
  return value;
}

async function daemonUid(): Promise<number> {
  const result = await executeFile("id", [
    "-u",
    requiredEnvironment("AGENTPORT_G1_DAEMON_USER"),
  ]);
  const uid = Number(result.stdout.trim());
  if (!Number.isSafeInteger(uid) || uid < 1) {
    throw new Error("Linux G1 daemon account must be non-root");
  }
  return uid;
}

export async function invokeFixtureAsDaemon<T>(
  fixturePath: string,
  request: Record<string, unknown>,
  timeoutMilliseconds: number,
): Promise<T> {
  const expectedUid = await daemonUid();
  const child = spawn(
    "/usr/sbin/runuser",
    [
      "--user",
      requiredEnvironment("AGENTPORT_G1_DAEMON_USER"),
      "--",
      "/usr/bin/env",
      "-i",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      process.execPath,
      fixturePath,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    errors += chunk;
  });
  child.stdin.end(JSON.stringify(request));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Timed out waiting for non-root Supervisor fixture"));
    }, timeoutMilliseconds + 5_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (exitCode !== 0) {
    throw new Error("Non-root Supervisor fixture failed", {
      cause: errors.slice(0, 2_048),
    });
  }
  const response = JSON.parse(output) as NonRootResponse<T>;
  if (response.uid !== expectedUid) {
    throw new Error("Supervisor fixture did not use the daemon identity");
  }
  return response.result;
}

export function linuxSupervisor(
  timeoutMilliseconds = 15_000,
): LinuxExecutionSupervisor {
  return new LinuxExecutionSupervisor(
    new LinuxLauncherClient({
      socketPath: requiredEnvironment("AGENTPORT_G1_LAUNCHER_SOCKET"),
      timeoutMilliseconds,
    }),
  );
}

export async function linuxReference(
  launchProfileId: string,
  executionId = `execution-${randomUUID()}`,
): Promise<ExecutionReference> {
  const daemonEpoch = await new LinuxLauncherClient({
    socketPath: requiredEnvironment("AGENTPORT_G1_LAUNCHER_SOCKET"),
  }).dispatchAuthority();
  if (daemonEpoch === undefined) {
    throw new Error("Linux launcher did not provide dispatch authority");
  }
  return {
    executionId,
    generation: `generation-${randomUUID()}`,
    daemonEpoch,
    launchProfileId,
    workspaceIdentity: requiredEnvironment("AGENTPORT_G1_WORKSPACE_IDENTITY"),
  };
}

export async function systemctl(
  args: readonly string[],
  timeoutMilliseconds = 10_000,
): Promise<string> {
  const result = await executeFile("systemctl", args, {
    encoding: "utf8",
    timeout: timeoutMilliseconds,
    maxBuffer: 64 * 1024,
  });
  return result.stdout.trim();
}

export async function executionCgroupPath(
  executionUnitId: string,
): Promise<string> {
  const controlGroup = await systemctl([
    "show",
    "--property=ControlGroup",
    "--value",
    executionUnitId,
  ]);
  if (!controlGroup.startsWith("/")) {
    throw new Error("Execution Unit has no cgroup path");
  }
  return join("/sys/fs/cgroup", controlGroup);
}

export async function descendantPids(cgroupPath: string): Promise<number[]> {
  const result = await executeFile("find", [
    cgroupPath,
    "-name",
    "cgroup.procs",
    "-type",
    "f",
    "-print",
  ]);
  const pids = new Set<number>();
  for (const file of result.stdout.trim().split("\n").filter(Boolean)) {
    for (const value of (await readFile(file, "utf8")).trim().split("\n")) {
      const pid = Number(value);
      if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  return [...pids];
}

export function ledgerPath(executionId: string): string {
  return join(
    requiredEnvironment("AGENTPORT_G1_LEDGER_DIRECTORY"),
    `${executionLedgerKey(executionId)}.json`,
  );
}

// A launcher restart seals prior-epoch ledger records before listening; on the
// OrbStack G1 target a graceful restart took about 24.5 s with 271 records.
export const LAUNCHER_RESTART_TIMEOUT_MS = 60_000;

export async function waitForPath(
  path: string,
  timeoutMilliseconds = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() <= deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

export async function restartLauncher(): Promise<void> {
  await systemctl(
    ["restart", requiredEnvironment("AGENTPORT_G1_LAUNCHER_SERVICE")],
    LAUNCHER_RESTART_TIMEOUT_MS,
  );
  await waitForLauncherReady();
}

async function waitForLauncherReady(): Promise<void> {
  const socketPath = requiredEnvironment("AGENTPORT_G1_LAUNCHER_SOCKET");
  const deadline = Date.now() + LAUNCHER_RESTART_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    try {
      const authority = await new LinuxLauncherClient({
        socketPath,
      }).dispatchAuthority();
      if (authority !== undefined) return;
    } catch {
      // A stale socket can exist while the replacement launcher initializes.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the launcher to become ready");
}

export async function abruptlyRestartLauncher(): Promise<void> {
  const service = requiredEnvironment("AGENTPORT_G1_LAUNCHER_SERVICE");
  const socketPath = requiredEnvironment("AGENTPORT_G1_LAUNCHER_SOCKET");
  const priorSocketInode = (await lstat(socketPath)).ino;
  const priorPid = await systemctl([
    "show",
    "--property=MainPID",
    "--value",
    service,
  ]);
  await systemctl(["kill", "--kill-whom=main", "--signal=SIGKILL", service]);
  const deadline = Date.now() + LAUNCHER_RESTART_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    try {
      const currentPid = await systemctl([
        "show",
        "--property=MainPID",
        "--value",
        service,
      ]);
      if (currentPid !== "0" && currentPid !== priorPid) {
        const socket = await lstat(socketPath);
        if (socket.isSocket() && socket.ino !== priorSocketInode) {
          await waitForLauncherReady();
          return;
        }
      }
    } catch {
      // The expected restart window is not a failure until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for an abrupt launcher restart");
}
