import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

if (process.platform !== "linux") {
  throw new Error("test:linux must run on the designated Linux target");
}
if (process.env.AGENTPORT_G1_LINUX !== "1") {
  throw new Error(
    "AGENTPORT_G1_LINUX=1 is required; refusing a skipped-all PASS",
  );
}
for (const name of [
  "AGENTPORT_G1_LAUNCHER_SOCKET",
  "AGENTPORT_G1_LEDGER_DIRECTORY",
  "AGENTPORT_G1_WORKSPACE_IDENTITY",
  "AGENTPORT_G1_RUNTIME_USER",
  "AGENTPORT_G1_RUNTIME_UID",
  "AGENTPORT_G1_RUNTIME_GID",
  "AGENTPORT_G1_CORE_DATA_PATH",
  "AGENTPORT_G1_LAUNCHER_SERVICE",
  "AGENTPORT_G1_LAUNCHER_CONFIG",
  "AGENTPORT_G1_RUNTIME_HOME",
  "AGENTPORT_G1_WORKSPACE_PATH",
  "AGENTPORT_G1_DAEMON_USER",
  "AGENTPORT_G1_G4_FIXTURE_ROOT",
  "AGENTPORT_G1_INGRESS_DIRECTORY",
  "AGENTPORT_G1_INGRESS_GID",
]) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}
if (
  process.env.AGENTPORT_G1_LAUNCHER_SOCKET !== "/run/agentport/launcher.sock"
) {
  throw new Error("AP-023 requires /run/agentport/launcher.sock");
}
if (process.env.AGENTPORT_G1_INGRESS_DIRECTORY !== "/run/agentport-ingress") {
  throw new Error("AP-023 requires /run/agentport-ingress");
}
const administratorGroup = await executeFile("getent", [
  "group",
  "agentport-admin",
]);
const administratorGroupId = Number(
  administratorGroup.stdout.trim().split(":")[2],
);
if (!Number.isSafeInteger(administratorGroupId) || administratorGroupId < 1) {
  throw new Error("agentport-admin group is invalid");
}
const [daemonGroups, runtimeGroups] = await Promise.all([
  executeFile("id", ["-G", process.env.AGENTPORT_G1_DAEMON_USER]),
  executeFile("id", ["-G", process.env.AGENTPORT_G1_RUNTIME_USER]),
]);
const groups = (output) => output.stdout.trim().split(/\s+/u).map(Number);
if (!groups(daemonGroups).includes(administratorGroupId)) {
  throw new Error("daemon account is not in agentport-admin");
}
if (groups(runtimeGroups).includes(administratorGroupId)) {
  throw new Error("Runtime account must not be in agentport-admin");
}
await access(process.env.AGENTPORT_G1_LAUNCHER_SOCKET);
const { LinuxLauncherClient } =
  await import("../dist/src/supervisor/linux/launcher-client.js");
const readinessDeadline = Date.now() + 60_000;
let dispatchAuthority;
while (Date.now() <= readinessDeadline) {
  try {
    dispatchAuthority = await new LinuxLauncherClient({
      socketPath: process.env.AGENTPORT_G1_LAUNCHER_SOCKET,
    }).dispatchAuthority();
    if (dispatchAuthority !== undefined) break;
  } catch {
    // A stale socket can remain while launcher recovery is still sealing units.
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (dispatchAuthority === undefined) {
  throw new Error("designated Linux launcher is not ready");
}
const cgroup = await stat("/sys/fs/cgroup");
if (!cgroup.isDirectory()) throw new Error("cgroup v2 root is unavailable");
const controllers = await readFile("/sys/fs/cgroup/cgroup.controllers", "utf8");
for (const required of ["cpu", "memory", "pids"]) {
  if (!controllers.split(/\s+/u).includes(required)) {
    throw new Error(
      `Required cgroup v2 controller is unavailable: ${required}`,
    );
  }
}
process.stdout.write("G1_LINUX_PREFLIGHT_OK\n");
