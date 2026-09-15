import { describe, expect, it } from "vitest";

import type {
  ExecutionSupervisor,
  SupervisorStopResult,
} from "../../src/core/execution-supervisor.js";
import { StorageIncidentCoordinator } from "../../src/bootstrap/storage-incident-coordinator.js";
import type { ExecutionReference } from "../../src/core/types.js";
import { isVerifiedLinuxStopEvidence } from "../../src/supervisor/linux/execution-supervisor.js";
import {
  LINUX_G1_ENABLED,
  linuxReference,
  linuxSupervisor,
} from "../fixtures/linux-supervisor.js";

describe.skipIf(!LINUX_G1_ENABLED)("S5 Linux storage-failure stop", () => {
  it("revokes every active exact Reference and proves each Execution Unit empty", async () => {
    const linux = linuxSupervisor();
    const stopCalls: ExecutionReference[] = [];
    const stopResults: Array<Promise<SupervisorStopResult>> = [];
    const recording: ExecutionSupervisor = {
      start: (...args) => linux.start(...args),
      reconcile: (reference) => linux.reconcile(reference),
      revokeAndStop(reference) {
        stopCalls.push(reference);
        const result = linux.revokeAndStop(reference);
        stopResults.push(result);
        return result;
      },
    };
    const incidents = new StorageIncidentCoordinator(recording, 4);
    const references = await Promise.all([
      linuxReference("g1-idle"),
      linuxReference("g1-descendants"),
    ]);
    try {
      for (const [index, reference] of references.entries()) {
        incidents.track(`storage-failure-task-${String(index + 1)}`, reference);
        await expect(linux.start(reference)).resolves.toMatchObject({
          kind: "started",
        });
      }

      incidents.report();

      await expect.poll(() => stopCalls).toEqual(references);
      const stopped = await Promise.all(stopResults);
      expect(stopped).toHaveLength(references.length);
      for (const [index, result] of stopped.entries()) {
        const reference = references[index];
        if (reference === undefined) throw new Error("Expected Reference");
        expect(result).toMatchObject({
          kind: "stopped",
          evidence: { reference },
        });
        if (result.kind !== "stopped")
          throw new Error("Expected stop evidence");
        expect(isVerifiedLinuxStopEvidence(result.evidence)).toBe(true);
        expect(
          Date.parse(result.evidence.unitEmptyObservedAt),
        ).toBeGreaterThanOrEqual(
          Date.parse(result.evidence.generationSealedAt),
        );
        await expect(linux.start(reference)).resolves.toEqual({
          kind: "pending",
        });
      }
    } finally {
      await Promise.allSettled(
        references.map((reference) => linux.revokeAndStop(reference)),
      );
    }
  }, 30_000);
});
