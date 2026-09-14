import { access, readFile, stat } from "node:fs/promises";

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
]) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}
await access(process.env.AGENTPORT_G1_LAUNCHER_SOCKET);
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
