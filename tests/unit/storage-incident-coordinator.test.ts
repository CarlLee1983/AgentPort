import { describe, expect, it } from "vitest";

import type {
  ExecutionSupervisor,
  SupervisorStartResult,
} from "../../src/core/execution-supervisor.js";
import { StorageIncidentCoordinator } from "../../src/bootstrap/storage-incident-coordinator.js";
import type { ExecutionReference } from "../../src/core/types.js";

const reference: ExecutionReference = {
  executionId: "execution-1",
  generation: "generation-1",
  daemonEpoch: "epoch-1",
  launchProfileId: "profile-1",
  workspaceIdentity: "workspace-1",
};

class RecordingSupervisor implements ExecutionSupervisor {
  readonly stopCalls: ExecutionReference[] = [];

  start(): Promise<SupervisorStartResult> {
    return Promise.resolve({ kind: "pending" });
  }

  revokeAndStop(value: ExecutionReference) {
    this.stopCalls.push(value);
    return Promise.resolve({ kind: "pending" } as const);
  }

  reconcile() {
    return Promise.resolve({ kind: "indeterminate" } as const);
  }
}

describe("StorageIncidentCoordinator", () => {
  it("bounds exact active References and latches stop fan-out idempotently", async () => {
    const supervisor = new RecordingSupervisor();
    const incidents = new StorageIncidentCoordinator(supervisor, 1);

    incidents.track("task-1", reference);
    incidents.track("task-1", { ...reference });
    expect(() => {
      incidents.track("task-1", { ...reference, generation: "generation-2" });
    }).toThrow(expect.objectContaining({ code: "operation_conflict" }));
    expect(() => {
      incidents.track("task-2", { ...reference, executionId: "execution-2" });
    }).toThrow(expect.objectContaining({ code: "storage_capacity" }));
    expect(() => {
      incidents.assertStartAllowed("task-1", reference);
    }).not.toThrow();

    incidents.report();
    incidents.report();
    await expect.poll(() => supervisor.stopCalls).toEqual([reference]);
    expect(() => {
      incidents.track("task-2", reference);
    }).toThrow(expect.objectContaining({ code: "storage_unavailable" }));
    expect(() => {
      incidents.assertStartAllowed("task-1", reference);
    }).toThrow(expect.objectContaining({ code: "storage_unavailable" }));
    incidents.release("task-1", reference);
    expect(incidents.isLatched()).toBe(true);
  });
});
