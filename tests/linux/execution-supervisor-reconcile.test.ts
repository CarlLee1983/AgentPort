import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { executionUnitNames } from "../../src/supervisor/linux/launcher-protocol.js";

import {
  abruptlyRestartLauncher,
  LAUNCHER_RESTART_TIMEOUT_MS,
  LINUX_G1_ENABLED,
  ledgerPath,
  linuxReference,
  linuxSupervisor,
  restartLauncher,
  systemctl,
  waitForPath,
} from "../fixtures/linux-supervisor.js";

const executeFile = promisify(execFile);

describe.skipIf(!LINUX_G1_ENABLED)(
  "Linux Execution Supervisor reconcile",
  () => {
    it("seals and empties a running unit after a client restart", async () => {
      const reference = await linuxReference("g1-idle");
      const first = linuxSupervisor();
      await expect(first.start(reference)).resolves.toMatchObject({
        kind: "started",
      });
      const restarted = linuxSupervisor();
      await expect(restarted.reconcile(reference)).resolves.toMatchObject({
        kind: "stopped",
        evidence: { reference },
      });
      await expect(restarted.start(reference)).resolves.toEqual({
        kind: "pending",
      });
    }, 20_000);

    it(
      "seals an unreleased generation and permits only reconcile after restart",
      async () => {
        const reference = await linuxReference("g1-delayed");
        const starting = linuxSupervisor().start(reference);
        await waitForPath(ledgerPath(reference.executionId));
        await restartLauncher();

        const interrupted = await starting;
        expect(["indeterminate", "pending", "unavailable"]).toContain(
          interrupted.kind,
        );
        await expect(linuxSupervisor().start(reference)).resolves.toEqual({
          kind: "conflict",
        });
        await expect(
          linuxSupervisor().reconcile(reference),
        ).resolves.toMatchObject({
          kind: "stopped",
          evidence: { reference },
        });
        const record: unknown = JSON.parse(
          await readFile(ledgerPath(reference.executionId), "utf8"),
        );
        expect(record).toMatchObject({ state: "sealed", releasedAt: null });
      },
      LAUNCHER_RESTART_TIMEOUT_MS * 2,
    );

    it(
      "rotates dispatch authority and rejects an unseen old-epoch start",
      async () => {
        const oldReference = await linuxReference("g1-idle");
        const sameTenureReference = await linuxReference("g1-idle");
        expect(sameTenureReference.daemonEpoch).toBe(oldReference.daemonEpoch);

        await restartLauncher();
        const currentReference = await linuxReference("g1-idle");
        expect(currentReference.daemonEpoch).not.toBe(oldReference.daemonEpoch);
        const staleUnseenReference = {
          ...currentReference,
          daemonEpoch: oldReference.daemonEpoch,
        };
        const supervisor = linuxSupervisor();

        await expect(supervisor.start(staleUnseenReference)).resolves.toEqual({
          kind: "conflict",
        });
        await expect(
          readFile(ledgerPath(staleUnseenReference.executionId), "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          systemctl([
            "is-active",
            executionUnitNames(staleUnseenReference.executionId).serviceUnit,
          ]),
        ).rejects.toBeInstanceOf(Error);

        try {
          await expect(
            supervisor.start(currentReference),
          ).resolves.toMatchObject({ kind: "started" });
        } finally {
          await supervisor.revokeAndStop(currentReference);
        }
      },
      LAUNCHER_RESTART_TIMEOUT_MS * 2,
    );

    it("converges a ledger-only delayed start without releasing it", async () => {
      const reference = await linuxReference("g1-delayed");
      const supervisor = linuxSupervisor();
      const starting = supervisor.start(reference);
      await new Promise((resolve) => setTimeout(resolve, 75));
      await expect(supervisor.reconcile(reference)).resolves.toMatchObject({
        kind: "stopped",
      });
      await expect(starting).resolves.toEqual({ kind: "pending" });
    }, 20_000);

    it("reconciles an indeterminate client timeout without replaying Runtime", async () => {
      const reference = await linuxReference("g1-delayed");
      await expect(linuxSupervisor(10).start(reference)).resolves.toEqual({
        kind: "indeterminate",
      });
      await expect(
        linuxSupervisor().reconcile(reference),
      ).resolves.toMatchObject({ kind: "stopped" });
      await expect(linuxSupervisor().start(reference)).resolves.toEqual({
        kind: "pending",
      });
    }, 20_000);

    it("withholds Stop Evidence while the Execution Unit cannot be proven empty", async () => {
      const reference = await linuxReference("g1-idle");
      const supervisor = linuxSupervisor();
      const units = executionUnitNames(reference.executionId);
      const blockerUnit = units.serviceUnit.replace(
        "agentport-worker-",
        "agentport-blocker-",
      );
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
      try {
        await expect(supervisor.revokeAndStop(reference)).resolves.toEqual({
          kind: "indeterminate",
        });
        const record: unknown = JSON.parse(
          await readFile(ledgerPath(reference.executionId), "utf8"),
        );
        expect(record).toMatchObject({
          state: "sealed",
          unitEmptyObservedAt: null,
        });
      } finally {
        await systemctl(["stop", blockerUnit]);
      }
      await expect(supervisor.reconcile(reference)).resolves.toMatchObject({
        kind: "stopped",
        evidence: { reference },
      });
    }, 30_000);

    it("converges an Execution Unit whose ledger record was lost", async () => {
      const reference = await linuxReference("g1-idle");
      const supervisor = linuxSupervisor();
      await expect(supervisor.start(reference)).resolves.toMatchObject({
        kind: "started",
      });
      await unlink(ledgerPath(reference.executionId));
      await expect(
        linuxSupervisor().reconcile(reference),
      ).resolves.toMatchObject({
        kind: "stopped",
      });
    }, 20_000);

    it(
      "sweeps a unit-only orphan before accepting starts after an abrupt restart",
      async () => {
        const reference = await linuxReference("g1-idle");
        const supervisor = linuxSupervisor();
        await expect(supervisor.start(reference)).resolves.toMatchObject({
          kind: "started",
        });
        await unlink(ledgerPath(reference.executionId));
        await abruptlyRestartLauncher();

        await expect(
          systemctl([
            "is-active",
            executionUnitNames(reference.executionId).serviceUnit,
          ]),
        ).rejects.toBeInstanceOf(Error);
        await expect(linuxSupervisor().reconcile(reference)).resolves.toEqual({
          kind: "indeterminate",
        });
      },
      LAUNCHER_RESTART_TIMEOUT_MS * 2,
    );

    it("fails closed and stops the established unit for a mismatched Reference", async () => {
      const reference = await linuxReference("g1-idle");
      const supervisor = linuxSupervisor();
      await expect(supervisor.reconcile(reference)).resolves.toEqual({
        kind: "indeterminate",
      });
      await expect(supervisor.start(reference)).resolves.toMatchObject({
        kind: "started",
      });
      await expect(
        supervisor.reconcile({ ...reference, generation: "generation-stale" }),
      ).resolves.toEqual({ kind: "conflict" });
      await expect(supervisor.start(reference)).resolves.toEqual({
        kind: "pending",
      });
      await expect(supervisor.revokeAndStop(reference)).resolves.toMatchObject({
        kind: "stopped",
      });
    }, 20_000);
  },
);
