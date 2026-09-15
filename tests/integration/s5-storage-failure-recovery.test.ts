import { describe, expect, it } from "vitest";

import { AgentRegistry } from "../../src/bootstrap/registry.js";
import { DurableAgentExecutionService } from "../../src/core/agent-execution-service.js";
import type {
  ExecutionSupervisor,
  SupervisorStartResult,
  VerifiedStopEvidence,
} from "../../src/core/execution-supervisor.js";
import { StorageIncidentCoordinator } from "../../src/bootstrap/storage-incident-coordinator.js";
import type { ExecutionReference } from "../../src/core/types.js";
import { ControlledRuntimeDispatcher } from "../../src/dispatcher/controlled-runtime-dispatcher.js";
import {
  SqliteDurableAdmissionStore,
  type TerminalStopEvidence,
} from "../../src/storage/sqlite-durable-admission-store.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

class FixtureLauncher {
  constructor(private readonly epoch: string) {}

  dispatchAuthority(): Promise<string | undefined> {
    return Promise.resolve(this.epoch);
  }
}

class StartupSupervisor implements ExecutionSupervisor {
  readonly events: Array<{
    kind: "reconcile" | "start" | "stop";
    reference: ExecutionReference;
  }> = [];

  start(reference: ExecutionReference): Promise<SupervisorStartResult> {
    this.events.push({ kind: "start", reference });
    return Promise.resolve({
      kind: "started",
      executionUnitId: `unit-${reference.executionId}`,
    });
  }

  revokeAndStop(reference: ExecutionReference) {
    this.events.push({ kind: "stop", reference });
    return Promise.resolve({
      kind: "stopped",
      evidence: evidenceFor(reference),
    } as const);
  }

  reconcile(reference: ExecutionReference) {
    this.events.push({ kind: "reconcile", reference });
    return Promise.resolve({
      kind: "running",
      executionUnitId: `unit-${reference.executionId}`,
    } as const);
  }
}

class IndeterminateRecoverySupervisor implements ExecutionSupervisor {
  readonly stopCalls: ExecutionReference[] = [];

  start(): Promise<SupervisorStartResult> {
    return Promise.resolve({ kind: "pending" });
  }

  revokeAndStop(reference: ExecutionReference) {
    this.stopCalls.push(reference);
    return Promise.resolve({ kind: "pending" } as const);
  }

  reconcile() {
    return Promise.resolve({ kind: "indeterminate" } as const);
  }
}

function evidenceFor(reference: ExecutionReference): VerifiedStopEvidence {
  return {
    kind: "verified",
    platform: "linux-cgroup-v2",
    reference,
    executionUnitId: `unit-${reference.executionId}`,
    generationSealedAt: "2026-09-15T00:00:00.000Z",
    unitEmptyObservedAt: "2026-09-15T00:00:01.000Z",
  };
}

function verifyEvidence(value: unknown): TerminalStopEvidence | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const evidence = value as VerifiedStopEvidence;
  return {
    platform: evidence.platform,
    reference: evidence.reference,
    executionUnitId: evidence.executionUnitId,
    generationSealedAt: evidence.generationSealedAt,
    unitEmptyObservedAt: evidence.unitEmptyObservedAt,
  };
}

describe("S5 storage-failure recovery", () => {
  it("reconciles retained References before reopening dispatch and never replays Runtime start", async () => {
    const initialSupervisor = new StartupSupervisor();
    const initialIncidents = new StorageIncidentCoordinator(
      initialSupervisor,
      4,
    );
    const fixture = await createDurableAdmissionFixture(
      {},
      { storageIncidentSafety: initialIncidents },
      initialIncidents,
    );
    let reopened: SqliteDurableAdmissionStore | undefined;
    try {
      const running = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "storage-recovery-running-submit",
          agentId: "agent-a",
          instruction: "retain this exact Reference across restart",
        },
      );
      await new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher("pre-restart-epoch"),
        initialSupervisor,
      ).dispatch(running.task.taskId);
      const originalReference = initialSupervisor.events.find(
        (event) => event.kind === "start",
      )?.reference;
      expect(originalReference).toBeDefined();

      await fixture.store.probe("truncatePhysicalControlReserve");
      await fixture.store.close();
      const recoverySupervisor = new StartupSupervisor();
      const recoveryIncidents = new StorageIncidentCoordinator(
        recoverySupervisor,
        4,
      );
      reopened = await SqliteDurableAdmissionStore.open(
        { databasePath: fixture.databasePath },
        recoveryIncidents,
      );
      const reconciledCapacity = (await reopened.probe(
        "inspectPhysicalCapacity",
      )) as {
        allocatedControlReserveBytes: number;
        controlReserveBytes: number;
        reservedControlBytes: number;
      };
      expect(reconciledCapacity.controlReserveBytes).toBe(
        reconciledCapacity.reservedControlBytes,
      );
      expect(reconciledCapacity.controlReserveBytes).toBeGreaterThan(0);
      expect(
        reconciledCapacity.allocatedControlReserveBytes,
      ).toBeGreaterThanOrEqual(reconciledCapacity.controlReserveBytes);
      const registry = await AgentRegistry.create(
        fixture.registryConfiguration,
        reopened,
      );
      const service = new DurableAgentExecutionService(registry, reopened, {
        cursorSecret: "storage-recovery-cursor-secret",
        newId: (() => {
          let id = 0;
          return () => `storage-recovery-id-${String(++id)}`;
        })(),
        stopEvidenceVerifier: { verify: verifyEvidence },
        storageIncidentSafety: recoveryIncidents,
      });

      await service.initializeAfterRestart(recoverySupervisor);

      expect(recoverySupervisor.events.slice(0, 2)).toEqual([
        { kind: "reconcile", reference: originalReference },
        { kind: "stop", reference: originalReference },
      ]);
      expect(
        recoverySupervisor.events.filter((event) => event.kind === "start"),
      ).toEqual([]);
      await expect(
        service.getTask(
          { principalId: "principal-a" },
          { taskId: running.task.taskId },
        ),
      ).resolves.toMatchObject({
        state: "recovering",
        execution: {
          state: "recovering",
          quarantined: true,
          recoveryReason: "daemon_restart",
        },
      });

      const newTask = await service.submitTask(
        { principalId: "principal-b" },
        {
          operationId: "storage-recovery-new-submit",
          agentId: "agent-b",
          instruction: "start only after reconciliation completes",
        },
      );
      await new ControlledRuntimeDispatcher(
        service,
        new FixtureLauncher("post-restart-epoch"),
        recoverySupervisor,
      ).dispatch(newTask.task.taskId);
      expect(recoverySupervisor.events.at(-1)).toMatchObject({
        kind: "start",
        reference: { daemonEpoch: "post-restart-epoch" },
      });
    } finally {
      await reopened?.close();
      await fixture.close();
    }
  });

  it("resolves a timed-out commit by its original receipt after replacement without duplicating intent", async () => {
    const initialSupervisor = new StartupSupervisor();
    const initialIncidents = new StorageIncidentCoordinator(
      initialSupervisor,
      4,
    );
    const fixture = await createDurableAdmissionFixture(
      { requestTimeoutMs: 500 },
      { storageIncidentSafety: initialIncidents },
      initialIncidents,
    );
    let reopened: SqliteDurableAdmissionStore | undefined;
    try {
      const running = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "storage-ambiguous-running-submit",
          agentId: "agent-a",
          instruction: "remain controlled during the ambiguous commit",
        },
      );
      await new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher("storage-ambiguous-old-epoch"),
        initialSupervisor,
      ).dispatch(running.task.taskId);

      const operationId = "storage-ambiguous-submit";
      const instruction = "commit after the caller timeout without duplication";
      void fixture.store.probe("block", 1_500).catch(() => undefined);
      await expect(
        fixture.service.submitTask(
          { principalId: "principal-b" },
          { operationId, agentId: "agent-b", instruction },
        ),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      expect(initialIncidents.isLatched()).toBe(true);
      await expect
        .poll(() =>
          initialSupervisor.events.filter((event) => event.kind === "stop"),
        )
        .toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 1_650));

      await fixture.store.close();
      const recoverySupervisor = new StartupSupervisor();
      const recoveryIncidents = new StorageIncidentCoordinator(
        recoverySupervisor,
        4,
      );
      reopened = await SqliteDurableAdmissionStore.open(
        { databasePath: fixture.databasePath },
        recoveryIncidents,
      );
      const registry = await AgentRegistry.create(
        fixture.registryConfiguration,
        reopened,
      );
      const service = new DurableAgentExecutionService(registry, reopened, {
        cursorSecret: "storage-ambiguous-recovery-secret",
        stopEvidenceVerifier: { verify: verifyEvidence },
        storageIncidentSafety: recoveryIncidents,
      });
      await service.initializeAfterRestart(recoverySupervisor);

      await expect(
        service.submitTask(
          { principalId: "principal-b" },
          { operationId, agentId: "agent-b", instruction },
        ),
      ).resolves.toMatchObject({
        replayed: true,
        task: { agentId: "agent-b", instruction },
      });
      await expect(
        service.listTasks({ principalId: "principal-b" }, {}),
      ).resolves.toMatchObject({
        tasks: [{ agentId: "agent-b" }],
      });
      await expect(
        service.submitTask(
          { principalId: "principal-b" },
          {
            operationId,
            agentId: "agent-b",
            instruction: "different ambiguous retry input",
          },
        ),
      ).rejects.toMatchObject({
        code: "operation_conflict",
        task: { agentId: "agent-b", instruction },
      });
      expect(
        recoverySupervisor.events.filter((event) => event.kind === "start"),
      ).toEqual([]);
    } finally {
      await reopened?.close();
      await fixture.close();
    }
  });

  it("keeps a replacement composition closed when Supervisor recovery is indeterminate", async () => {
    const initialSupervisor = new StartupSupervisor();
    const initialIncidents = new StorageIncidentCoordinator(
      initialSupervisor,
      4,
    );
    const fixture = await createDurableAdmissionFixture(
      {},
      { storageIncidentSafety: initialIncidents },
      initialIncidents,
    );
    let reopened: SqliteDurableAdmissionStore | undefined;
    try {
      const running = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "storage-indeterminate-running-submit",
          agentId: "agent-a",
          instruction: "keep recovery closed without trusted stop evidence",
        },
      );
      await new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher("storage-indeterminate-old-epoch"),
        initialSupervisor,
      ).dispatch(running.task.taskId);
      await fixture.store.close();

      const supervisor = new IndeterminateRecoverySupervisor();
      const incidents = new StorageIncidentCoordinator(supervisor, 4);
      reopened = await SqliteDurableAdmissionStore.open(
        { databasePath: fixture.databasePath },
        incidents,
      );
      const registry = await AgentRegistry.create(
        fixture.registryConfiguration,
        reopened,
      );
      const service = new DurableAgentExecutionService(registry, reopened, {
        cursorSecret: "storage-indeterminate-recovery-secret",
        storageIncidentSafety: incidents,
      });

      await expect(
        service.initializeAfterRestart(supervisor),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      expect(incidents.isLatched()).toBe(true);
      await expect.poll(() => supervisor.stopCalls).toHaveLength(1);
      await expect(
        service.submitTask(
          { principalId: "principal-b" },
          {
            operationId: "storage-indeterminate-late-submit",
            agentId: "agent-b",
            instruction: "must remain closed",
          },
        ),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
    } finally {
      await reopened?.close();
      await fixture.close();
    }
  });
});
