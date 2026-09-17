import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { isVerifiedLinuxStopEvidence } from "../../src/supervisor/linux/execution-supervisor.js";
import { executionUnitNames } from "../../src/supervisor/linux/launcher-protocol.js";
import {
  LAUNCHER_RESTART_TIMEOUT_MS,
  LINUX_G1_ENABLED,
  descendantPids,
  executionCgroupPath,
  ledgerPath,
  linuxReference,
  linuxSupervisor,
  restartLauncher,
  systemctl,
} from "../fixtures/linux-supervisor.js";

const executeFile = promisify(execFile);

describe.skipIf(!LINUX_G1_ENABLED)("G5 Linux crash-window matrix", () => {
  it("withholds exact Stop Evidence while a sealed Execution Unit still contains a process", async () => {
    const reference = await linuxReference("g1-idle");
    const units = executionUnitNames(reference.executionId);
    const blockerUnit = units.serviceUnit.replace(
      "agentport-worker-",
      "agentport-blocker-",
    );
    const supervisor = linuxSupervisor();
    let blockerStarted = false;
    let primaryError: Error | undefined;
    let cgroupPath: string | undefined;

    try {
      await expect(supervisor.start(reference)).resolves.toMatchObject({
        kind: "started",
      });
      await executeFile("systemd-run", [
        "--quiet",
        `--unit=${blockerUnit}`,
        `--slice=${units.executionUnitId}`,
        "--service-type=exec",
        "--collect",
        "/bin/sleep",
        "600",
      ]);
      blockerStarted = true;
      cgroupPath = await executionCgroupPath(units.executionUnitId);
      expect(await descendantPids(cgroupPath)).not.toHaveLength(0);

      await expect(supervisor.revokeAndStop(reference)).resolves.toEqual({
        kind: "indeterminate",
      });
      const sealed: unknown = JSON.parse(
        await readFile(ledgerPath(reference.executionId), "utf8"),
      );
      expect(sealed).toMatchObject({
        reference,
        state: "sealed",
        unitEmptyObservedAt: null,
      });
      expect(await descendantPids(cgroupPath)).not.toHaveLength(0);
      expect((await supervisor.reconcile(reference)).kind).not.toBe("stopped");
      expect((await supervisor.start(reference)).kind).not.toBe("started");

      await systemctl(["stop", blockerUnit]);
      blockerStarted = false;
      try {
        const events = await readFile(
          join(cgroupPath, "cgroup.events"),
          "utf8",
        );
        expect(events).toMatch(/^populated 0$/m);
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
        await expect(stat(cgroupPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      const reconciled = await supervisor.reconcile(reference);
      expect(reconciled.kind).toBe("stopped");
      if (reconciled.kind !== "stopped") {
        throw new Error("Expected exact Stop Evidence after the unit emptied");
      }
      expect(isVerifiedLinuxStopEvidence(reconciled.evidence)).toBe(true);
      expect(reconciled.evidence.reference).toEqual(reference);
      expect(reconciled.evidence.executionUnitId).toBe(units.executionUnitId);
      expect(
        Date.parse(reconciled.evidence.unitEmptyObservedAt),
      ).toBeGreaterThanOrEqual(
        Date.parse(reconciled.evidence.generationSealedAt),
      );
      const recorded: unknown = JSON.parse(
        await readFile(ledgerPath(reference.executionId), "utf8"),
      );
      expect(recorded).toMatchObject({
        reference,
        state: "sealed",
        generationSealedAt: reconciled.evidence.generationSealedAt,
        unitEmptyObservedAt: reconciled.evidence.unitEmptyObservedAt,
      });
    } catch (error) {
      primaryError =
        error instanceof Error
          ? error
          : new Error("G5 nonempty-unit assertion failed");
    }

    const cleanupErrors: Error[] = [];
    if (blockerStarted) {
      try {
        await systemctl(["stop", blockerUnit]);
      } catch (error) {
        cleanupErrors.push(
          error instanceof Error ? error : new Error("Blocker cleanup failed"),
        );
      }
    }
    try {
      const cleanup = await supervisor.revokeAndStop(reference);
      if (cleanup.kind !== "stopped") {
        cleanupErrors.push(
          new Error("Exact Execution Unit cleanup is unknown"),
        );
      }
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error
          ? error
          : new Error("G5 supervisor cleanup failed"),
      );
    }
    if (primaryError !== undefined && cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "G5 nonempty-unit assertion and cleanup failed",
      );
    }
    if (primaryError !== undefined) throw primaryError;
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "G5 nonempty-unit cleanup failed",
      );
    }
  }, 45_000);

  it(
    "seals a running generation across two launcher restarts without a second start",
    async () => {
      const reference = await linuxReference("g1-idle");
      const units = executionUnitNames(reference.executionId);
      let primaryError: Error | undefined;

      try {
        await expect(linuxSupervisor().start(reference)).resolves.toMatchObject(
          {
            kind: "started",
          },
        );

        await restartLauncher();
        const first = await linuxSupervisor().reconcile(reference);
        expect(first.kind).toBe("stopped");
        if (first.kind !== "stopped") throw new Error("Expected Stop Evidence");
        expect(isVerifiedLinuxStopEvidence(first.evidence)).toBe(true);

        await restartLauncher();
        const second = await linuxSupervisor().reconcile(reference);
        expect(second.kind).toBe("stopped");
        if (second.kind !== "stopped")
          throw new Error("Expected Stop Evidence");
        expect(isVerifiedLinuxStopEvidence(second.evidence)).toBe(true);
        expect(second.evidence.reference).toEqual(reference);
        expect(second.evidence.executionUnitId).toBe(units.executionUnitId);
        expect(second.evidence.generationSealedAt).toBe(
          first.evidence.generationSealedAt,
        );
        expect(
          Date.parse(second.evidence.unitEmptyObservedAt),
        ).toBeGreaterThanOrEqual(
          Date.parse(first.evidence.unitEmptyObservedAt),
        );

        const lateStart = await linuxSupervisor().start(reference);
        expect(lateStart.kind).not.toBe("started");
        await expect(
          systemctl(["is-active", units.serviceUnit]),
        ).rejects.toBeInstanceOf(Error);
        const recorded: unknown = JSON.parse(
          await readFile(ledgerPath(reference.executionId), "utf8"),
        );
        expect(recorded).toMatchObject({
          reference,
          state: "sealed",
          generationSealedAt: second.evidence.generationSealedAt,
          unitEmptyObservedAt: second.evidence.unitEmptyObservedAt,
        });
      } catch (error) {
        primaryError =
          error instanceof Error
            ? error
            : new Error("G5 restart assertion failed");
      }

      let cleanupError: Error | undefined;
      try {
        const cleanup = await linuxSupervisor().revokeAndStop(reference);
        if (cleanup.kind !== "stopped") {
          cleanupError = new Error("Exact Execution Unit cleanup is unknown");
        }
      } catch (error) {
        cleanupError =
          error instanceof Error ? error : new Error("G5 cleanup failed");
      }
      if (primaryError !== undefined && cleanupError !== undefined) {
        throw new AggregateError(
          [primaryError, cleanupError],
          "G5 launcher restart and cleanup failed",
        );
      }
      if (primaryError !== undefined) throw primaryError;
      if (cleanupError !== undefined) throw cleanupError;
    },
    LAUNCHER_RESTART_TIMEOUT_MS * 3,
  );
});
