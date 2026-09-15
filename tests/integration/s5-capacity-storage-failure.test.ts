import { describe, expect, it } from "vitest";

import type {
  ExecutionSupervisor,
  SupervisorStartResult,
} from "../../src/core/execution-supervisor.js";
import { StorageIncidentCoordinator } from "../../src/bootstrap/storage-incident-coordinator.js";
import type { ExecutionReference } from "../../src/core/types.js";
import { ControlledRuntimeDispatcher } from "../../src/dispatcher/controlled-runtime-dispatcher.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

class FixtureLauncher {
  dispatchAuthority(): Promise<string | undefined> {
    return Promise.resolve("capacity-epoch");
  }
}

class RecordingSupervisor implements ExecutionSupervisor {
  readonly startCalls: ExecutionReference[] = [];
  readonly stopCalls: ExecutionReference[] = [];

  start(reference: ExecutionReference): Promise<SupervisorStartResult> {
    this.startCalls.push(reference);
    return Promise.resolve({
      kind: "started",
      executionUnitId: `unit-${reference.executionId}`,
    });
  }

  revokeAndStop(reference: ExecutionReference) {
    this.stopCalls.push(reference);
    return Promise.resolve({ kind: "pending" } as const);
  }

  reconcile() {
    return Promise.resolve({ kind: "indeterminate" } as const);
  }
}

describe("S5 expected capacity behavior", () => {
  it("keeps the incident latch open for configured admission-byte saturation", async () => {
    const supervisor = new RecordingSupervisor();
    const incidents = new StorageIncidentCoordinator(supervisor, 4);
    const fixture = await createDurableAdmissionFixture(
      { admissionBytes: 1 },
      { storageIncidentSafety: incidents },
      incidents,
    );
    try {
      await expect(
        fixture.service.submitTask(
          { principalId: "principal-a" },
          {
            operationId: "configured-storage-capacity-submit",
            agentId: "agent-a",
            instruction: "exceed one byte",
          },
        ),
      ).rejects.toMatchObject({ code: "storage_capacity" });
      expect(incidents.isLatched()).toBe(false);
      expect(supervisor.stopCalls).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("does not trip the storage incident latch when receipt capacity is exhausted", async () => {
    const supervisor = new RecordingSupervisor();
    const incidents = new StorageIncidentCoordinator(supervisor, 4);
    const fixture = await createDurableAdmissionFixture(
      { receiptCapacity: 1 },
      { storageIncidentSafety: incidents },
      incidents,
    );
    try {
      const accepted = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "capacity-accepted-submit",
          agentId: "agent-a",
          instruction: "remain dispatchable after expected saturation",
        },
      );

      await expect(
        fixture.service.submitTask(
          { principalId: "principal-a" },
          {
            operationId: "capacity-rejected-submit",
            agentId: "agent-a",
            instruction: "exceed the configured receipt capacity",
          },
        ),
      ).rejects.toMatchObject({ code: "tombstone_capacity" });

      const dispatcher = new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher(),
        supervisor,
      );
      await expect(dispatcher.dispatch(accepted.task.taskId)).resolves.toEqual({
        kind: "started",
      });
      expect(supervisor.startCalls).toHaveLength(1);
      expect(supervisor.stopCalls).toEqual([]);
      expect(incidents.isLatched()).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it("keeps Task control open when the bounded product-audit drain fails", async () => {
    const supervisor = new RecordingSupervisor();
    const incidents = new StorageIncidentCoordinator(supervisor, 4);
    const fixture = await createDurableAdmissionFixture(
      { auditCapacity: 1 },
      { storageIncidentSafety: incidents },
      incidents,
    );
    try {
      const accepted = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "audit-failure-accepted-submit",
          agentId: "agent-a",
          instruction: "remain controllable when audit drain fails",
        },
      );
      await fixture.store.probe("failAuditGapPermanently");
      const audits = ["first", "second", "latest"].map((resultCode) =>
        fixture.store
          .recordAudit({
            principalId: "principal-a",
            method: "tools/list",
            toolName: null,
            protocolVersion: "2026-07-28",
            clientName: null,
            clientVersion: null,
            clientCapabilitiesJson: null,
            resultCode,
            createdAt: "2026-09-15T00:00:00.000Z",
          })
          .catch(() => undefined),
      );
      await Promise.all(audits);
      await expect(fixture.store.flushAudit()).rejects.toMatchObject({
        code: "storage_unavailable",
      });

      expect(incidents.isLatched()).toBe(false);
      await expect(
        new ControlledRuntimeDispatcher(
          fixture.service,
          new FixtureLauncher(),
          supervisor,
        ).dispatch(accepted.task.taskId),
      ).resolves.toEqual({ kind: "started" });
      expect(supervisor.startCalls).toHaveLength(1);
      expect(supervisor.stopCalls).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
