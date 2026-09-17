import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
} from "node:path";
import { promisify } from "node:util";

import {
  assessProtectedIngressDirectory,
  observeIngressDirectory,
} from "../supervisor/linux/ingress-directory.js";
import { readProtectedLinuxLauncherOptions } from "../supervisor/linux/launcher-configuration.js";
import type { LinuxLauncherServerOptions } from "../supervisor/linux/launcher-server.js";

const execFileAsync = promisify(execFile);
const accountName = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u;

export interface LinuxPreflightConfiguration {
  launcherConfigurationPath: string;
  daemonUser: string;
  databasePath: string;
}

export interface LinuxPreflightCheck {
  code: string;
  outcome: "pass" | "fail" | "not_assessed";
}

export interface LinuxPreflightResult {
  status:
    "preparation_valid" | "configuration_invalid" | "unsupported_platform";
  dispatchEligible: false;
  checks: LinuxPreflightCheck[];
}

interface AccountIdentity {
  uid: number;
  gid: number;
  groups: readonly number[];
}

interface PathMetadata {
  kind: "directory" | "file" | "socket" | "symlink" | "other";
  uid: number;
  gid: number;
  mode: number;
}

interface LinuxPreflightDependencies {
  platform: string;
  uid: number;
  readLauncher(path: string): Promise<LinuxLauncherServerOptions>;
  account(name: string): Promise<AccountIdentity>;
  group(name: string): Promise<number>;
  metadata(path: string): Promise<PathMetadata | undefined>;
  canonical(path: string): Promise<string>;
  runtimeAccess(
    path: string,
    user: string,
    permission: "read" | "write" | "traverse",
  ): Promise<boolean>;
}

function protectedAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    normalize(value) === value
  );
}

function contained(path: string, ancestor: string): boolean {
  const offset = relative(ancestor, path);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function writableBy(
  metadata: PathMetadata,
  identity: AccountIdentity,
): boolean {
  return (
    (metadata.uid === identity.uid && (metadata.mode & 0o200) !== 0) ||
    (identity.groups.includes(metadata.gid) && (metadata.mode & 0o020) !== 0) ||
    (metadata.mode & 0o002) !== 0
  );
}

async function inspectDirectoryChain(
  directory: string,
  runtime: AccountIdentity,
  runtimeUser: string,
  dependencies: LinuxPreflightDependencies,
): Promise<PathMetadata | undefined> {
  const root = parse(directory).root;
  const rootMetadata = await dependencies.metadata(root);
  if (
    rootMetadata?.kind !== "directory" ||
    rootMetadata.uid !== 0 ||
    writableBy(rootMetadata, runtime) ||
    (await dependencies.runtimeAccess(root, runtimeUser, "write"))
  ) {
    return undefined;
  }
  let current = root;
  for (const segment of directory
    .slice(root.length)
    .split("/")
    .filter(Boolean)) {
    current = current === root ? `${root}${segment}` : `${current}/${segment}`;
    const metadata = await dependencies.metadata(current);
    if (
      metadata?.kind !== "directory" ||
      (metadata.mode & 0o002) !== 0 ||
      writableBy(metadata, runtime) ||
      (await dependencies.runtimeAccess(current, runtimeUser, "write"))
    ) {
      return undefined;
    }
  }
  return dependencies.metadata(directory);
}

async function inspectDatabasePath(
  path: string,
  daemon: AccountIdentity,
  runtime: AccountIdentity,
  runtimeUser: string,
  dependencies: LinuxPreflightDependencies,
): Promise<boolean> {
  const parent = await inspectDirectoryChain(
    dirname(path),
    runtime,
    runtimeUser,
    dependencies,
  );
  if (
    parent === undefined ||
    !writableBy(parent, daemon) ||
    (await dependencies.runtimeAccess(dirname(path), runtimeUser, "traverse"))
  ) {
    return false;
  }
  for (const filePath of [
    path,
    `${path}-wal`,
    `${path}-shm`,
    `${path}.control-reserve`,
  ]) {
    const metadata = await dependencies.metadata(filePath);
    if (
      metadata !== undefined &&
      (metadata.kind !== "file" ||
        writableBy(metadata, runtime) ||
        !writableBy(metadata, daemon) ||
        (await dependencies.runtimeAccess(filePath, runtimeUser, "read")) ||
        (await dependencies.runtimeAccess(filePath, runtimeUser, "write")))
    ) {
      return false;
    }
  }
  return true;
}

async function realAccount(name: string): Promise<AccountIdentity> {
  const options = { timeout: 2_000, maxBuffer: 4096 };
  const [uid, gid, groups] = await Promise.all([
    execFileAsync("id", ["-u", name], options),
    execFileAsync("id", ["-g", name], options),
    execFileAsync("id", ["-G", name], options),
  ]);
  const identity = {
    uid: Number(uid.stdout.trim()),
    gid: Number(gid.stdout.trim()),
    groups: groups.stdout.trim().split(/\s+/u).map(Number),
  };
  if (
    !Number.isSafeInteger(identity.uid) ||
    !Number.isSafeInteger(identity.gid) ||
    identity.groups.length === 0 ||
    identity.groups.some((value) => !Number.isSafeInteger(value))
  ) {
    throw new Error("Invalid account identity");
  }
  return identity;
}

async function realGroup(name: string): Promise<number> {
  const result = await execFileAsync("getent", ["group", name], {
    timeout: 2_000,
    maxBuffer: 4096,
  });
  const gid = Number(result.stdout.trim().split(":")[2]);
  if (!Number.isSafeInteger(gid)) throw new Error("Invalid group identity");
  return gid;
}

async function realMetadata(path: string): Promise<PathMetadata | undefined> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return {
    kind: metadata.isSymbolicLink()
      ? "symlink"
      : metadata.isDirectory()
        ? "directory"
        : metadata.isFile()
          ? "file"
          : metadata.isSocket()
            ? "socket"
            : "other",
    uid: metadata.uid,
    gid: metadata.gid,
    mode: metadata.mode,
  };
}

/** Internal OS probe shared with the Linux failure-contract fixture. */
export async function probeRuntimeAccessAsUser(
  path: string,
  user: string,
  permission: "read" | "write" | "traverse",
): Promise<boolean> {
  const flag =
    permission === "read" ? "-r" : permission === "write" ? "-w" : "-x";
  const probe =
    'if test "$1" "$2"; then printf ALLOW; else status=$?; if [ "$status" -eq 1 ]; then printf DENY; else exit 99; fi; fi';
  const result = await execFileAsync(
    "runuser",
    ["-u", user, "--", "/bin/sh", "-c", probe, "preflight", flag, path],
    {
      timeout: 2_000,
      maxBuffer: 4096,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
    },
  );
  if (result.stdout === "ALLOW") return true;
  if (result.stdout === "DENY") return false;
  throw new Error("Runtime access probe did not complete");
}

function defaultDependencies(): LinuxPreflightDependencies {
  return {
    platform: process.platform,
    uid: process.getuid?.() ?? -1,
    readLauncher: readProtectedLinuxLauncherOptions,
    account: realAccount,
    group: realGroup,
    metadata: realMetadata,
    canonical: realpath,
    runtimeAccess: probeRuntimeAccessAsUser,
  };
}

/** Administrator-only preparation check. It never opens SQLite or claims dispatch readiness. */
export async function preflightLinuxOperations(
  configuration: LinuxPreflightConfiguration,
  dependencies: LinuxPreflightDependencies = defaultDependencies(),
): Promise<LinuxPreflightResult> {
  const checks: LinuxPreflightCheck[] = [];
  const check = (
    code: string,
    outcome: LinuxPreflightCheck["outcome"],
  ): void => {
    checks.push({ code, outcome });
  };
  const finish = (): LinuxPreflightResult => ({
    status: checks.some(({ outcome }) => outcome === "fail")
      ? "configuration_invalid"
      : "preparation_valid",
    dispatchEligible: false,
    checks,
  });

  if (dependencies.platform !== "linux") {
    return {
      status: "unsupported_platform",
      dispatchEligible: false,
      checks: [{ code: "linux_target", outcome: "fail" }],
    };
  }
  if (dependencies.uid !== 0) {
    check("administrator_identity", "fail");
    return finish();
  }
  check("administrator_identity", "pass");
  if (
    !protectedAbsolutePath(configuration.launcherConfigurationPath) ||
    !protectedAbsolutePath(configuration.databasePath) ||
    !accountName.test(configuration.daemonUser)
  ) {
    check("configuration_fields", "fail");
    return finish();
  }
  check("configuration_fields", "pass");

  let launcher: LinuxLauncherServerOptions;
  try {
    launcher = await dependencies.readLauncher(
      configuration.launcherConfigurationPath,
    );
    check("launcher_configuration", "pass");
  } catch {
    check("launcher_configuration", "fail");
    return finish();
  }
  const launcherPaths = [
    launcher.socketPath,
    launcher.ledgerDirectory,
    launcher.workspaceRoot,
    launcher.runtimeHome,
    launcher.nodeExecutable,
    launcher.ingressDirectory,
    ...Object.values(launcher.profiles).flatMap((profile) => [
      profile.workspacePath,
      profile.workerEntrypoint,
    ]),
  ];
  if (!launcherPaths.every(protectedAbsolutePath)) {
    check("launcher_paths", "fail");
    return finish();
  }
  check("launcher_paths", "pass");

  let daemon: AccountIdentity;
  let runtime: AccountIdentity;
  let socketGid: number;
  let runtimeGid: number;
  let ingressGid: number;
  try {
    [daemon, runtime, socketGid, runtimeGid, ingressGid] = await Promise.all([
      dependencies.account(configuration.daemonUser),
      dependencies.account(launcher.runtimeUser),
      dependencies.group(launcher.socketGroup),
      dependencies.group(launcher.runtimeGroup),
      dependencies.group(launcher.ingressGroup),
    ]);
  } catch {
    check("account_lookup", "fail");
    return finish();
  }
  check(
    "identity_separation",
    daemon.uid > 0 &&
      runtime.uid > 0 &&
      daemon.uid !== runtime.uid &&
      runtime.gid === runtimeGid &&
      socketGid !== runtimeGid &&
      ingressGid !== socketGid &&
      ingressGid !== runtimeGid &&
      daemon.groups.includes(socketGid) &&
      daemon.groups.includes(ingressGid) &&
      daemon.groups.includes(runtimeGid) &&
      runtime.groups.length > 0 &&
      runtime.groups.every((gid) => gid === runtimeGid) &&
      !runtime.groups.includes(ingressGid)
      ? "pass"
      : "fail",
  );

  try {
    const [
      databaseParent,
      runtimeHome,
      workspaceRoot,
      ledgerDirectory,
      ingressDirectory,
    ] = await Promise.all([
      dependencies.canonical(dirname(configuration.databasePath)),
      dependencies.canonical(launcher.runtimeHome),
      dependencies.canonical(launcher.workspaceRoot),
      dependencies.canonical(launcher.ledgerDirectory),
      dependencies.canonical(launcher.ingressDirectory),
    ]);
    const databasePath = join(
      databaseParent,
      basename(configuration.databasePath),
    );
    check(
      "database_scope",
      ![runtimeHome, workspaceRoot, ledgerDirectory, ingressDirectory].some(
        (path) => contained(databasePath, path),
      )
        ? "pass"
        : "fail",
    );
  } catch {
    check("database_scope", "fail");
  }

  try {
    check(
      "database_permissions",
      (await inspectDatabasePath(
        configuration.databasePath,
        daemon,
        runtime,
        launcher.runtimeUser,
        dependencies,
      ))
        ? "pass"
        : "fail",
    );
    const ledger = await inspectDirectoryChain(
      launcher.ledgerDirectory,
      runtime,
      launcher.runtimeUser,
      dependencies,
    );
    const socketParent = await inspectDirectoryChain(
      dirname(launcher.socketPath),
      runtime,
      launcher.runtimeUser,
      dependencies,
    );
    const socket = await dependencies.metadata(launcher.socketPath);
    check(
      "launcher_control_paths",
      ledger?.kind === "directory" &&
        ledger.uid === 0 &&
        socketParent?.kind === "directory" &&
        socketParent.uid === 0 &&
        !(await dependencies.runtimeAccess(
          launcher.ledgerDirectory,
          launcher.runtimeUser,
          "traverse",
        )) &&
        !(await dependencies.runtimeAccess(
          dirname(launcher.socketPath),
          launcher.runtimeUser,
          "traverse",
        )) &&
        (socket === undefined ||
          (socket.kind === "socket" &&
            socket.uid === 0 &&
            socket.gid === socketGid &&
            !(await dependencies.runtimeAccess(
              launcher.socketPath,
              launcher.runtimeUser,
              "read",
            )) &&
            !(await dependencies.runtimeAccess(
              launcher.socketPath,
              launcher.runtimeUser,
              "write",
            ))))
        ? "pass"
        : "fail",
    );
    const ingressAssessment = assessProtectedIngressDirectory(
      await observeIngressDirectory(
        launcher.ingressDirectory,
        dependencies.uid,
        async (path) => {
          const metadata = await dependencies.metadata(path);
          return metadata === undefined
            ? undefined
            : {
                isDirectory: metadata.kind === "directory",
                isSymbolicLink: metadata.kind === "symlink",
                uid: metadata.uid,
                gid: metadata.gid,
                mode: metadata.mode,
              };
        },
      ),
      { ingressGroupId: ingressGid, allowRootProcess: true },
    );
    check("worker_ingress_path", ingressAssessment.ok ? "pass" : "fail");
  } catch {
    check("path_inspection", "fail");
  }
  check("runtime_executables", "not_assessed");
  check("caller_group_isolation", "not_assessed");
  check("worker_credentials", "not_assessed");
  check("schema_recovery", "not_assessed");
  check("supervisor_stop", "not_assessed");
  check("broker_provisioning", "not_assessed");
  check("https_proxy", "not_assessed");
  return finish();
}
