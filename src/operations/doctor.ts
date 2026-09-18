import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  evaluateDeploymentReadiness,
  type DeploymentReadinessSnapshot,
} from "../daemon/deployment-readiness.js";
import {
  readProtectedDaemonConfiguration,
  type DaemonConfiguration,
} from "../daemon/configuration.js";
import { readProtectedLinuxLauncherOptions } from "../supervisor/linux/launcher-configuration.js";

const execFileAsync = promisify(execFile);
export const DOCTOR_LIVE_TIMEOUT_MS = 10_000;
export const DEFAULT_LAUNCHER_CONFIGURATION_PATH =
  "/etc/agentport/launcher.json";

export class DoctorError extends Error {
  constructor(readonly code: "doctor_arguments_invalid" | "doctor_forbidden") {
    super(code);
    this.name = "DoctorError";
  }
}

export interface DoctorArguments {
  readonly configurationPath: string;
  readonly live: boolean;
}

export interface DoctorResult {
  readonly version: 1;
  readonly readiness: DeploymentReadinessSnapshot;
}

export interface DoctorDependencies {
  getUid(): number | undefined;
  now(): string;
  readConfiguration(
    path: string,
    expectedGroupId?: number,
  ): Promise<DaemonConfiguration>;
  groupId(group: string): Promise<number>;
  readLauncher(
    path: string,
  ): ReturnType<typeof readProtectedLinuxLauncherOptions>;
  lstat(path: string): ReturnType<typeof lstat>;
  liveHealth(input: {
    runtimeUser: string;
    runtimeHome: string;
    nodeExecutable: string;
  }): Promise<boolean>;
}

function parseDoctorArguments(arguments_: readonly string[]): DoctorArguments {
  if (
    (arguments_.length !== 2 && arguments_.length !== 3) ||
    arguments_[0] !== "--config" ||
    arguments_[1] === undefined ||
    arguments_[1].length === 0 ||
    (arguments_.length === 3 && arguments_[2] !== "--live")
  ) {
    throw new DoctorError("doctor_arguments_invalid");
  }
  return { configurationPath: arguments_[1], live: arguments_.length === 3 };
}

async function validProtectedTopology(
  configuration: DaemonConfiguration,
  daemonGroupId: number,
  launcherSocketGroupId: number,
  dependencies: DoctorDependencies,
): Promise<boolean> {
  try {
    const [launcherSocket, launcherParent, ingress] = await Promise.all([
      dependencies.lstat(configuration.launcher.socketPath),
      dependencies.lstat(dirname(configuration.launcher.socketPath)),
      dependencies.lstat(configuration.launcher.workerIngressDirectory),
    ]);
    return (
      launcherSocket.isSocket() &&
      launcherSocket.uid === 0 &&
      launcherSocket.gid === configuration.launcher.socketGroupId &&
      launcherSocket.gid === launcherSocketGroupId &&
      launcherSocket.gid !== configuration.adminSocket.groupId &&
      (Number(launcherSocket.mode) & 0o777) === 0o660 &&
      launcherParent.isDirectory() &&
      !launcherParent.isSymbolicLink() &&
      launcherParent.uid === 0 &&
      launcherParent.gid === daemonGroupId &&
      (Number(launcherParent.mode) & 0o7777) === 0o1771 &&
      ingress.isDirectory() &&
      !ingress.isSymbolicLink() &&
      ingress.uid === 0 &&
      ingress.gid === configuration.launcher.ingressGroupId &&
      (Number(ingress.mode) & 0o777) === 0o771
    );
  } catch {
    return false;
  }
}

async function liveHealth(input: {
  runtimeUser: string;
  runtimeHome: string;
  nodeExecutable: string;
}): Promise<boolean> {
  try {
    const probePath = fileURLToPath(
      new URL("./doctor-live-probe-main.js", import.meta.url),
    );
    await execFileAsync(
      "/usr/sbin/runuser",
      [
        "-u",
        input.runtimeUser,
        "--",
        "/usr/bin/env",
        "-i",
        `HOME=${input.runtimeHome}`,
        `CLAUDE_CONFIG_DIR=${join(input.runtimeHome, ".claude")}`,
        "PATH=/usr/local/bin:/usr/bin:/bin",
        input.nodeExecutable,
        probePath,
      ],
      {
        timeout: DOCTOR_LIVE_TIMEOUT_MS,
        maxBuffer: 4_096,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
      },
    );
    return true;
  } catch {
    return false;
  }
}

async function groupId(group: string): Promise<number> {
  try {
    const result = await execFileAsync("/usr/bin/getent", ["group", group], {
      timeout: 2_000,
      maxBuffer: 4_096,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    });
    const value = Number(result.stdout.trim().split(":")[2]);
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error("invalid group");
    return value;
  } catch {
    throw new Error("group unavailable");
  }
}

const defaultDependencies: DoctorDependencies = {
  getUid: () => process.getuid?.(),
  now: () => new Date().toISOString(),
  readConfiguration: readProtectedDaemonConfiguration,
  groupId,
  readLauncher: readProtectedLinuxLauncherOptions,
  lstat,
  liveHealth,
};

/**
 * Runs the administrator-only deployment diagnostic. It deliberately never
 * opens the daemon's SQLite store or reads daemon credentials. The live probe
 * is opt-in and executes in the Runtime identity with an empty inherited env.
 */
export async function doctor(
  arguments_: readonly string[],
  dependencies: DoctorDependencies = defaultDependencies,
): Promise<DoctorResult> {
  const parsedArguments = parseDoctorArguments(arguments_);
  if (dependencies.getUid() !== 0) throw new DoctorError("doctor_forbidden");

  let configuration: DaemonConfiguration;
  try {
    const daemonGroupId = await dependencies.groupId("agentport-daemon");
    configuration = await dependencies.readConfiguration(
      parsedArguments.configurationPath,
      daemonGroupId,
    );
  } catch {
    return {
      version: 1,
      readiness: evaluateDeploymentReadiness({
        observedAt: null,
        observation: "unobserved",
        capabilities: {
          service: "unavailable",
          agents: "unknown",
          launcher: "unknown",
          runtime: "unknown",
          callerProvisioning: "unknown",
          protectedTopology: "unknown",
        },
        recovery: "unknown",
        storage: "unknown",
      }),
    };
  }

  let launcher:
    Awaited<ReturnType<DoctorDependencies["readLauncher"]>> | undefined;
  try {
    launcher = await dependencies.readLauncher(
      DEFAULT_LAUNCHER_CONFIGURATION_PATH,
    );
    const [daemonGroupId, launcherSocketGroupId] = await Promise.all([
      dependencies.groupId("agentport-daemon"),
      dependencies.groupId(launcher.socketGroup),
    ]);
    let topology = await validProtectedTopology(
      configuration,
      daemonGroupId,
      launcherSocketGroupId,
      dependencies,
    );
    if (
      launcher.socketPath !== configuration.launcher.socketPath ||
      configuration.launcher.socketGroupId !== launcherSocketGroupId ||
      launcher.ingressDirectory !==
        configuration.launcher.workerIngressDirectory
    ) {
      topology = false;
    }
    return await doctorResult(
      parsedArguments,
      configuration,
      topology,
      launcher,
      dependencies,
    );
  } catch {
    return await doctorResult(
      parsedArguments,
      configuration,
      false,
      undefined,
      dependencies,
    );
  }
}

async function doctorResult(
  parsedArguments: DoctorArguments,
  configuration: DaemonConfiguration,
  topology: boolean,
  launcher: Awaited<ReturnType<DoctorDependencies["readLauncher"]>> | undefined,
  dependencies: DoctorDependencies,
): Promise<DoctorResult> {
  let runtime: "verified" | "unverified" | "unknown" = "unverified";
  if (parsedArguments.live) {
    try {
      if (launcher === undefined) throw new Error("launcher unavailable");
      runtime = (await dependencies.liveHealth(launcher))
        ? "verified"
        : "unverified";
    } catch {
      runtime = "unknown";
    }
  }
  return {
    version: 1,
    readiness: evaluateDeploymentReadiness({
      observedAt: dependencies.now(),
      observation: "current",
      capabilities: {
        service: "unavailable",
        agents: configuration.agents.length === 0 ? "none" : "configured",
        launcher: topology ? "ready" : "unavailable",
        runtime,
        callerProvisioning: "absent",
        protectedTopology: topology ? "valid" : "invalid",
      },
      recovery: "unknown",
      storage: "unknown",
    }),
  };
}
