import { describe, expect, it } from "vitest";

import {
  createExecutionSupervisor,
  parseWorkerObservation,
  type ExecutionReference,
  type ExecutionSupervisorAdapter,
} from "../../src/core/execution-supervisor.js";

const reference: ExecutionReference = {
  executionId: "execution-1",
  generation: "generation-1",
  daemonEpoch: "epoch-1",
  launchProfileId: "managed-profile-1",
  workspaceIdentity: "workspace-identity-1",
};

describe("Execution Supervisor contract", () => {
  it("accepts only bounded Worker observations bound to the current Reference", () => {
    expect(
      parseWorkerObservation(reference, {
        reference,
        kind: "progress",
        ordinal: 1,
        summary: "fixture progress",
      }),
    ).toMatchObject({ kind: "progress", ordinal: 1 });
    expect(
      parseWorkerObservation(reference, {
        reference: { ...reference, generation: "unbound-generation" },
        kind: "progress",
        ordinal: 1,
        summary: "must be rejected",
      }),
    ).toBeUndefined();
    expect(
      parseWorkerObservation(reference, {
        reference,
        kind: "progress",
        ordinal: 2,
        summary: "x".repeat(1025),
      }),
    ).toBeUndefined();
  });

  it("normalizes a fixture start and permanently closes its Reference when revoked", async () => {
    let starts = 0;
    const adapter: ExecutionSupervisorAdapter = {
      start: () => {
        starts += 1;
        return Promise.resolve({ unitId: "opaque-unit-1" });
      },
      revokeAndStop: () => Promise.resolve({ kind: "pending" }),
      reconcile: () => Promise.resolve({ kind: "indeterminate" }),
    };
    const supervisor = createExecutionSupervisor(adapter);

    await expect(
      Promise.all([supervisor.start(reference), supervisor.start(reference)]),
    ).resolves.toEqual([{ kind: "indeterminate" }, { kind: "indeterminate" }]);
    expect(starts).toBe(0);

    await expect(supervisor.revokeAndStop(reference)).resolves.toEqual({
      kind: "indeterminate",
    });
    await expect(supervisor.start(reference)).resolves.toEqual({
      kind: "pending",
    });
  });

  it("does not treat a scripted stopped result as Stop Evidence", async () => {
    const adapter: ExecutionSupervisorAdapter = {
      start: () => Promise.resolve({ unitId: "opaque-unit-1" }),
      revokeAndStop: () =>
        Promise.resolve({
          kind: "stopped",
          evidence: { kind: "scripted", reference },
        }),
      reconcile: () => Promise.resolve({ kind: "indeterminate" }),
    };
    const supervisor = createExecutionSupervisor(adapter);

    await expect(supervisor.revokeAndStop(reference)).resolves.toEqual({
      kind: "indeterminate",
    });
  });

  it("does not accept a structurally forged verified Stop Evidence", async () => {
    const adapter: ExecutionSupervisorAdapter = {
      start: () => Promise.resolve({ unitId: "opaque-unit-1" }),
      revokeAndStop: () =>
        Promise.resolve({
          kind: "stopped",
          evidence: { kind: "verified", reference, unitId: "forged-unit" },
        }),
      reconcile: () => Promise.resolve({ kind: "indeterminate" }),
    };

    await expect(
      createExecutionSupervisor(adapter).revokeAndStop(reference),
    ).resolves.toEqual({ kind: "indeterminate" });
  });

  it("retains the established generation for timeouts and stale References", async () => {
    const adapter: ExecutionSupervisorAdapter = {
      start: () => Promise.reject(new Error("timed out")),
      revokeAndStop: () => Promise.reject(new Error("timed out")),
      reconcile: () => Promise.reject(new Error("ledger unavailable")),
    };
    const supervisor = createExecutionSupervisor(adapter);
    const stale = { ...reference, generation: "generation-stale" };

    await expect(supervisor.start(reference)).resolves.toEqual({
      kind: "indeterminate",
    });
    await expect(supervisor.start(stale)).resolves.toEqual({
      kind: "indeterminate",
    });
    await expect(supervisor.revokeAndStop(stale)).resolves.toEqual({
      kind: "indeterminate",
    });
    await expect(supervisor.reconcile(reference)).resolves.toEqual({
      kind: "indeterminate",
    });
  });
});
