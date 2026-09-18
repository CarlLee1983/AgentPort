import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  chown,
  lstat,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  RuntimeWorkerObservationSequence,
  type RuntimeWorkerObservation,
} from "../../src/runtime/worker/protocol.js";
import { executionUnitNames } from "../../src/supervisor/linux/launcher-protocol.js";
import {
  LINUX_G1_ENABLED,
  descendantPids,
  executionCgroupPath,
  linuxReference,
  linuxSupervisor,
  ledgerPath,
  requiredEnvironment,
} from "../fixtures/linux-supervisor.js";

const executeFile = promisify(execFile);

async function runtimeCanRead(path: string): Promise<boolean> {
  return runtimeCanAccess("-r", path);
}

async function runtimeCanWrite(path: string): Promise<boolean> {
  return runtimeCanAccess("-w", path);
}

async function runtimeCanAccess(
  flag: "-r" | "-w",
  path: string,
): Promise<boolean> {
  try {
    await executeFile("runuser", [
      "-u",
      requiredEnvironment("AGENTPORT_G1_RUNTIME_USER"),
      "--",
      "test",
      flag,
      path,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function runtimeCanConnect(path: string): Promise<boolean> {
  try {
    await executeFile("runuser", [
      "-u",
      requiredEnvironment("AGENTPORT_G1_RUNTIME_USER"),
      "--",
      process.execPath,
      "-e",
      "require('node:net').connect(process.argv[1]).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))",
      path,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function runtimeCanList(path: string): Promise<boolean> {
  try {
    await executeFile("runuser", [
      "-u",
      requiredEnvironment("AGENTPORT_G1_RUNTIME_USER"),
      "--",
      "ls",
      path,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function launcherIngress(): Promise<{
  ingressDirectory: string;
  ingressGid: number;
}> {
  const configuration = JSON.parse(
    await readFile(requiredEnvironment("AGENTPORT_G1_LAUNCHER_CONFIG"), "utf8"),
  ) as { ingressDirectory: string; ingressGroup: string };
  const group = await executeFile("getent", [
    "group",
    configuration.ingressGroup,
  ]);
  return {
    ingressDirectory: configuration.ingressDirectory,
    ingressGid: Number(group.stdout.trim().split(":")[2]),
  };
}

async function runtimeCanUnlink(path: string): Promise<boolean> {
  try {
    await executeFile("runuser", [
      "-u",
      requiredEnvironment("AGENTPORT_G1_RUNTIME_USER"),
      "--",
      "rm",
      "-f",
      path,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function runtimeCanRename(
  source: string,
  destination: string,
): Promise<boolean> {
  try {
    await executeFile("runuser", [
      "-u",
      requiredEnvironment("AGENTPORT_G1_RUNTIME_USER"),
      "--",
      "mv",
      source,
      destination,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function workerJournal(reference: {
  executionId: string;
}): Promise<string> {
  const unit = executionUnitNames(reference.executionId).serviceUnit;
  return (
    await executeFile(
      "journalctl",
      ["--unit", unit, "--output=cat", "--no-pager", "--quiet"],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024 },
    )
  ).stdout;
}

async function waitForCandidate(
  reference: Awaited<ReturnType<typeof linuxReference>>,
): Promise<RuntimeWorkerObservation[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() <= deadline) {
    const sequence = new RuntimeWorkerObservationSequence();
    const observations: RuntimeWorkerObservation[] = [];
    const frames = (await workerJournal(reference))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{"kind"'));
    for (const frame of frames) {
      const observation = sequence.accept(reference, frame);
      if (observation === undefined) throw new Error("Invalid worker frame");
      observations.push(observation);
    }
    if (observations.some((value) => value.kind === "candidate")) {
      return observations;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for isolation probe");
}

describe.skipIf(!LINUX_G1_ENABLED)("Linux Runtime isolation", () => {
  it("starts the Runtime worker with only its protected execution environment", async () => {
    const reference = await linuxReference("g1-idle");
    const supervisor = linuxSupervisor();
    const started = await supervisor.start(reference);
    expect(started).toMatchObject({ kind: "started" });
    if (started.kind !== "started") throw new Error("Worker did not start");
    try {
      const cgroupPath = await executionCgroupPath(started.executionUnitId);
      const pids = await descendantPids(cgroupPath);
      expect(pids).toHaveLength(1);
      const commandLine = await readFile(
        `/proc/${String(pids[0])}/cmdline`,
        "utf8",
      );
      expect(commandLine).not.toContain("--reference");
      expect(commandLine).not.toContain("--ingress-token");
      expect(commandLine).not.toContain(reference.executionId);
      expect(commandLine).not.toContain(reference.generation);
      const environment = new Set(
        (await readFile(`/proc/${String(pids[0])}/environ`, "utf8"))
          .split("\0")
          .filter(Boolean),
      );
      const runtimeHome = requiredEnvironment("AGENTPORT_G1_RUNTIME_HOME");
      const runtimeUser = requiredEnvironment("AGENTPORT_G1_RUNTIME_USER");
      expect(environment).toEqual(
        new Set([
          `HOME=${runtimeHome}`,
          `CLAUDE_CONFIG_DIR=${runtimeHome}/.claude`,
          `CREDENTIALS_DIRECTORY=/run/credentials/${executionUnitNames(reference.executionId).serviceUnit}`,
          `LOGNAME=${runtimeUser}`,
          "PATH=/usr/local/bin:/usr/bin:/bin",
          `USER=${runtimeUser}`,
          // Node 24.21.0 on the designated Linux target derives this marker
          // after env -i; it is not launcher, Caller, or credential input.
          "UV_USE_IO_URING=0",
        ]),
      );
    } finally {
      await supervisor.revokeAndStop(reference);
    }
  }, 20_000);

  it("keeps ledger, launcher, and core data outside the Runtime account", async () => {
    const ledger = requiredEnvironment("AGENTPORT_G1_LEDGER_DIRECTORY");
    const socket = requiredEnvironment("AGENTPORT_G1_LAUNCHER_SOCKET");
    const coreData = requiredEnvironment("AGENTPORT_G1_CORE_DATA_PATH");
    const launcherConfig = requiredEnvironment("AGENTPORT_G1_LAUNCHER_CONFIG");
    const runtimeHome = requiredEnvironment("AGENTPORT_G1_RUNTIME_HOME");
    const workspace = requiredEnvironment("AGENTPORT_G1_WORKSPACE_PATH");
    const socketDirectory = dirname(socket);
    expect((await stat(ledger)).mode & 0o777).toBe(0o700);
    expect((await stat(socket)).mode & 0o777).toBe(0o660);
    const socketDirectoryMetadata = await stat(socketDirectory);
    if (socket === "/run/agentport/launcher.sock") {
      // Gate-056 deliberately shares this sticky parent with the daemon's
      // admin socket. The fixed location prevents widening that exception.
      expect(socketDirectoryMetadata.mode & 0o7777).toBe(0o1771);
    } else {
      expect(socketDirectoryMetadata.mode & 0o777).toBe(0o750);
    }
    expect(socketDirectoryMetadata.uid).toBe(0);
    for (const protectedPath of [
      ledger,
      socket,
      socketDirectory,
      coreData,
      launcherConfig,
      "/mnt/mac",
    ]) {
      await expect(runtimeCanRead(protectedPath)).resolves.toBe(false);
      await expect(runtimeCanWrite(protectedPath)).resolves.toBe(false);
    }
    await expect(runtimeCanRead(runtimeHome)).resolves.toBe(true);
    await expect(runtimeCanWrite(runtimeHome)).resolves.toBe(true);
    await expect(runtimeCanRead(workspace)).resolves.toBe(true);
    await expect(runtimeCanWrite(workspace)).resolves.toBe(true);
  });

  it("uses a credential without projecting its marker into evidence", async () => {
    const marker = `credential-shaped-${randomUUID()}`;
    const markerPath = `${requiredEnvironment("AGENTPORT_G1_RUNTIME_HOME")}/.agentport-g1-test-credential`;
    const reference = await linuxReference("g1-isolation-probe");
    const supervisor = linuxSupervisor();
    await writeFile(markerPath, marker, { mode: 0o600 });
    await chown(
      markerPath,
      Number(requiredEnvironment("AGENTPORT_G1_RUNTIME_UID")),
      Number(requiredEnvironment("AGENTPORT_G1_RUNTIME_GID")),
    );
    await chmod(markerPath, 0o600);
    let started: Awaited<ReturnType<typeof supervisor.start>> | undefined;
    let stopped:
      Awaited<ReturnType<typeof supervisor.revokeAndStop>> | undefined;
    try {
      started = await supervisor.start(reference);
      expect(started).toMatchObject({ kind: "started" });
      const observations = await waitForCandidate(reference);
      expect(observations).toEqual([
        expect.objectContaining({
          kind: "progress",
          summary: "credential-available",
        }),
        expect.objectContaining({
          kind: "candidate",
          outcome: "succeeded",
          summary: "isolation-probe-ok",
        }),
      ]);
      stopped = await supervisor.revokeAndStop(reference);
      expect(stopped).toMatchObject({ kind: "stopped" });
      const projected = JSON.stringify({
        observations,
        started,
        stopped,
        ledger: await readFile(ledgerPath(reference.executionId), "utf8"),
        journal: await workerJournal(reference),
      });
      expect(projected).not.toContain(marker);
      expect(projected).not.toContain(markerPath);
    } finally {
      if (stopped?.kind !== "stopped") {
        await supervisor.revokeAndStop(reference);
      }
      await unlink(markerPath).catch(() => undefined);
    }
  }, 20_000);

  it("rejects a caller-selected Workspace identity before persisting a generation", async () => {
    const reference = await linuxReference("g1-idle");
    await expect(
      linuxSupervisor().start({
        ...reference,
        workspaceIdentity: "caller-selected-workspace",
      }),
    ).resolves.toEqual({ kind: "conflict" });
  });

  it("cannot select another launch profile for an established execution", async () => {
    const reference = await linuxReference("g1-idle");
    const supervisor = linuxSupervisor();
    await expect(supervisor.start(reference)).resolves.toMatchObject({
      kind: "started",
    });
    await expect(
      supervisor.start({ ...reference, launchProfileId: "g1-descendants" }),
    ).resolves.toEqual({ kind: "conflict" });
    await supervisor.revokeAndStop(reference);
  }, 20_000);

  it("creates the launcher-owned ingress directory as root:ingressGroup 0771 (AP-021 R2)", async () => {
    const { ingressDirectory, ingressGid } = await launcherIngress();
    const directoryStat = await lstat(ingressDirectory);
    expect(directoryStat.isDirectory()).toBe(true);
    expect(directoryStat.mode & 0o7777).toBe(0o771);
    expect(directoryStat.uid).toBe(0);
    expect(directoryStat.gid).toBe(ingressGid);
  });

  it("creates a daemon-owned 0660 Runtime-group ingress socket the Runtime identity can use but not remove or replace (AP-021 R4)", async () => {
    const { ingressDirectory } = await launcherIngress();
    const daemonUser = requiredEnvironment("AGENTPORT_G1_DAEMON_USER");
    const runtimeGid = Number(requiredEnvironment("AGENTPORT_G1_RUNTIME_GID"));
    const daemonUid = Number(
      (await executeFile("id", ["-u", daemonUser])).stdout.trim(),
    );
    const child = spawn(
      "runuser",
      [
        "-u",
        daemonUser,
        "--",
        process.execPath,
        join(
          process.cwd(),
          "dist-fixtures/tests/fixtures/ingress-socket-child.js",
        ),
        ingressDirectory,
        String(runtimeGid),
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", resolve);
    });
    try {
      const line = await new Promise<string>((resolve, reject) => {
        let buffer = "";
        child.stdout.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const newline = buffer.indexOf("\n");
          if (newline >= 0) resolve(buffer.slice(0, newline));
        });
        child.once("exit", () => {
          reject(new Error("Ingress socket child exited before opening"));
        });
      });
      const observation = JSON.parse(line) as {
        endpoint: string;
        processUid: number;
      };
      expect(observation.processUid).toBe(daemonUid);
      expect(observation.processUid).toBeGreaterThan(0);
      const socketStat = await lstat(observation.endpoint);
      expect(socketStat.isSocket()).toBe(true);
      expect(socketStat.mode & 0o7777).toBe(0o660);
      expect(socketStat.uid).toBe(daemonUid);
      expect(socketStat.gid).toBe(runtimeGid);

      await expect(runtimeCanConnect(observation.endpoint)).resolves.toBe(true);
      await expect(runtimeCanList(ingressDirectory)).resolves.toBe(false);
      await expect(runtimeCanUnlink(observation.endpoint)).resolves.toBe(false);
      await expect(
        runtimeCanRename(
          observation.endpoint,
          `${ingressDirectory}/replaced-${randomUUID()}.sock`,
        ),
      ).resolves.toBe(false);
      const after = await lstat(observation.endpoint);
      expect(after.ino).toBe(socketStat.ino);
    } finally {
      child.stdin.end();
      await exited;
    }
  }, 20_000);
});
