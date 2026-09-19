import { execFile } from "node:child_process";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { executionUnitNames } from "../../src/supervisor/linux/launcher-protocol.js";
import {
  invokeFixtureAsDaemon,
  ledgerPath,
  LINUX_G1_ENABLED,
  requiredEnvironment,
  systemctl,
} from "../fixtures/linux-supervisor.js";

const executeFile = promisify(execFile);

interface PreparedRecovery {
  activeTaskId: string;
  queuedTaskId: string;
  executionId: string;
}

describe.skipIf(!LINUX_G1_ENABLED)("non-root composition recovery", () => {
  it("pauses queued work and quarantines an unknown Execution after restart (AC-06)", async () => {
    const fixtureRoot = requiredEnvironment("AGENTPORT_G1_G4_FIXTURE_ROOT");
    const base = await mkdtemp(join(fixtureRoot, "r-"));
    const databaseDirectory = join(base, "db");
    const daemonUser = requiredEnvironment("AGENTPORT_G1_DAEMON_USER");
    const daemonUid = Number(
      (await executeFile("id", ["-u", daemonUser])).stdout.trim(),
    );
    const daemonGid = Number(
      (await executeFile("id", ["-g", daemonUser])).stdout.trim(),
    );
    await chmod(base, 0o711);
    await mkdir(databaseDirectory, { mode: 0o700 });
    await chown(databaseDirectory, daemonUid, daemonGid);
    const childPath = join(
      process.cwd(),
      "dist-fixtures/tests/fixtures/ap021-recovery-child.js",
    );
    const common = {
      databasePath: join(databaseDirectory, "agentport.sqlite"),
      workspacePath: requiredEnvironment("AGENTPORT_G1_WORKSPACE_PATH"),
      socketPath: requiredEnvironment("AGENTPORT_G1_LAUNCHER_SOCKET"),
      socketGroupId: (
        await lstat(requiredEnvironment("AGENTPORT_G1_LAUNCHER_SOCKET"))
      ).gid,
      ingressDirectory: requiredEnvironment("AGENTPORT_G1_INGRESS_DIRECTORY"),
      runtimeGroupId: Number(requiredEnvironment("AGENTPORT_G1_RUNTIME_GID")),
      ingressGroupId: Number(requiredEnvironment("AGENTPORT_G1_INGRESS_GID")),
    };
    let prepared: PreparedRecovery | undefined;
    try {
      prepared = await invokeFixtureAsDaemon<PreparedRecovery>(
        childPath,
        { action: "prepare", ...common },
        30_000,
      );
      const units = executionUnitNames(prepared.executionId);
      await systemctl(["stop", units.serviceUnit]);
      await systemctl(["stop", units.executionUnitId]);
      await unlink(ledgerPath(prepared.executionId));

      await expect(
        invokeFixtureAsDaemon(
          childPath,
          {
            action: "recover",
            ...common,
            activeTaskId: prepared.activeTaskId,
            queuedTaskId: prepared.queuedTaskId,
          },
          30_000,
        ),
      ).resolves.toEqual({
        activeState: "recovering",
        activeQuarantined: true,
        queuedState: "paused",
        queuedReason: "daemon_restart",
      });
    } finally {
      if (prepared !== undefined) {
        const units = executionUnitNames(prepared.executionId);
        await systemctl(["stop", units.serviceUnit]).catch(() => undefined);
        await systemctl(["stop", units.executionUnitId]).catch(() => undefined);
        await unlink(ledgerPath(prepared.executionId)).catch(() => undefined);
      }
      await rm(base, { recursive: true, force: true });
    }
  }, 60_000);
});
