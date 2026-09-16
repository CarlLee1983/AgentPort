import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AgentRegistry } from "../../src/bootstrap/registry.js";
import {
  DurableAgentExecutionService,
  type ControlledRuntimeDispatchLifecycle,
} from "../../src/core/agent-execution-service.js";
import type {
  ExecutionSupervisor,
  SupervisorStartResult,
} from "../../src/core/execution-supervisor.js";
import type { ExecutionReference } from "../../src/core/types.js";
import { ControlledRuntimeDispatcher } from "../../src/dispatcher/controlled-runtime-dispatcher.js";
import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";
import { RuntimeWorkerIngress } from "../../src/runtime/worker/ingress.js";
import { RuntimeWorkerIngressClient } from "../../src/runtime/worker/ingress-client.js";
import { encodeWorkerObservation } from "../../src/runtime/worker/protocol.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

const actor = { principalId: "principal-a" };

const questionSchema = [
  {
    question: "Which color should be used?",
    header: "Color",
    options: [
      { label: "Blue", description: "Use blue" },
      { label: "Red", description: "Use red" },
    ],
    multiSelect: false,
  },
] as const;

class UncertainStartSupervisor implements ExecutionSupervisor {
  readonly starts: ExecutionReference[] = [];
  readonly reconciliations: ExecutionReference[] = [];

  start(reference: ExecutionReference): Promise<SupervisorStartResult> {
    this.starts.push(reference);
    return Promise.resolve({ kind: "unavailable" });
  }

  revokeAndStop() {
    return Promise.resolve({ kind: "pending" } as const);
  }

  reconcile(reference: ExecutionReference) {
    this.reconciliations.push(reference);
    return Promise.resolve({ kind: "indeterminate" } as const);
  }
}

class RecordedStartedSupervisor implements ExecutionSupervisor {
  readonly starts: ExecutionReference[] = [];
  readonly reconciliations: ExecutionReference[] = [];

  start(reference: ExecutionReference): Promise<SupervisorStartResult> {
    this.starts.push(reference);
    return Promise.resolve({
      kind: "started",
      executionUnitId: "scripted-g5-launched-unit",
    });
  }

  revokeAndStop() {
    return Promise.resolve({ kind: "pending" } as const);
  }

  reconcile(reference: ExecutionReference) {
    this.reconciliations.push(reference);
    return Promise.resolve({ kind: "indeterminate" } as const);
  }
}

class ThrowingRecoverySupervisor implements ExecutionSupervisor {
  readonly reconciliations: ExecutionReference[] = [];

  start(): Promise<SupervisorStartResult> {
    throw new Error("recovery must not create a new Runtime start");
  }

  revokeAndStop() {
    return Promise.resolve({ kind: "pending" } as const);
  }

  reconcile(reference: ExecutionReference) {
    this.reconciliations.push(reference);
    return Promise.reject(new Error("synthetic reconciliation crash"));
  }
}

describe("G5 crash-window matrix", () => {
  it("replays a durable admission receipt after response loss and leaves no durable admission before commit", async () => {
    const fixture = await createDurableAdmissionFixture();
    let restartedStore: SqliteDurableAdmissionStore | undefined;
    try {
      const input = {
        operationId: "g5-admission-response-loss",
        agentId: "agent-a",
        instruction: "admit once across a lost response",
      };
      const committed = await fixture.service.submitTask(actor, input);

      await fixture.store.close();
      restartedStore = await SqliteDurableAdmissionStore.open({
        databasePath: join(fixture.directory, "agentport.sqlite"),
      });
      const restarted = new DurableAgentExecutionService(
        await AgentRegistry.create(
          fixture.registryConfiguration,
          restartedStore,
        ),
        restartedStore,
        { cursorSecret: "g5-admission-restart-secret" },
      );
      await restarted.initializeAfterRestart();

      await expect(restarted.submitTask(actor, input)).resolves.toMatchObject({
        replayed: true,
        task: { taskId: committed.task.taskId, state: "paused" },
      });
      await expect(
        restartedStore.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: committed.task.taskId,
        }),
      ).resolves.toBeUndefined();
      await expect(
        restartedStore.probe("inspectDurability"),
      ).resolves.toMatchObject({
        receipts: 1,
      });

      const preCommit = await createDurableAdmissionFixture();
      try {
        await preCommit.store.probe("failNextCommit");
        await expect(
          preCommit.service.submitTask(actor, {
            operationId: "g5-admission-pre-commit",
            agentId: "agent-a",
            instruction: "do not start before admission commits",
          }),
        ).rejects.toMatchObject({ code: "storage_unavailable" });
        await expect(
          preCommit.service.getTask(actor, { taskId: "fixture-id-1" }),
        ).rejects.toMatchObject({ code: "not_found" });
        await expect(
          preCommit.store.probe("inspectDurability"),
        ).resolves.toMatchObject({
          receipts: 0,
          contexts: 0,
        });
      } finally {
        await preCommit.close();
      }
    } finally {
      await restartedStore?.close();
      await fixture.close();
    }
  });

  it("keeps the candidate and Workspace claim through a terminal-commit crash and restart", async () => {
    const fixture = await createDurableAdmissionFixture(
      {},
      { stopEvidenceVerifier: { verify: (value) => value as never } },
    );
    let restartedStore: SqliteDurableAdmissionStore | undefined;
    let secondRestartStore: SqliteDurableAdmissionStore | undefined;
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "g5-terminal-commit-crash",
        agentId: "agent-a",
        instruction: "retain the candidate until terminal evidence commits",
      });
      const preparation = await fixture.service.prepareForDispatch(
        submitted.task.taskId,
        "g5-terminal-daemon-epoch",
      );
      await fixture.service.markExecutionRunning(preparation.reference);
      const reference = preparation.reference;
      await fixture.recordObservation(actor, {
        taskId: submitted.task.taskId,
        observation: {
          reference,
          kind: "candidate",
          ordinal: 1,
          finalOrdinal: 1,
          outcome: { kind: "completed", summary: "bounded candidate" },
        },
      });
      const evidence = {
        platform: "linux-cgroup-v2",
        reference,
        executionUnitId: "g5-contract-fixture-unit",
        generationSealedAt: "2026-09-15T00:00:00.000Z",
        unitEmptyObservedAt: "2026-09-15T00:00:01.000Z",
      };

      await fixture.store.probe("failNextCommit");
      await expect(
        fixture.service.commitVerifiedStop(evidence),
      ).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      await expect(
        fixture.store.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        state: "stopping",
        candidateAvailable: true,
        finalOrdinal: 1,
        workspaceClaim: "held",
      });

      await fixture.store.close();
      restartedStore = await SqliteDurableAdmissionStore.open({
        databasePath: fixture.databasePath,
      });
      const restarted = new DurableAgentExecutionService(
        await AgentRegistry.create(
          fixture.registryConfiguration,
          restartedStore,
        ),
        restartedStore,
        { cursorSecret: "g5-terminal-restart-secret" },
      );
      await restarted.initializeAfterRestart();

      await expect(
        restartedStore.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        state: "recovering",
        candidateAvailable: true,
        finalOrdinal: 1,
        workspaceClaim: "quarantined",
      });
      await expect(
        restarted.getTask(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        result: null,
        execution: { state: "recovering", candidateAvailable: true },
      });

      await expect(
        restartedStore.expireRetainedData({
          asOf: "2026-12-15T00:00:00.000Z",
        }),
      ).resolves.toMatchObject({ tasksExpired: 0 });
      await expect(
        restarted.getTask(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        result: null,
        execution: {
          state: "recovering",
          candidateAvailable: true,
        },
      });

      await restartedStore.close();
      restartedStore = undefined;
      secondRestartStore = await SqliteDurableAdmissionStore.open({
        databasePath: fixture.databasePath,
      });
      const secondRestart = new DurableAgentExecutionService(
        await AgentRegistry.create(
          fixture.registryConfiguration,
          secondRestartStore,
        ),
        secondRestartStore,
        { cursorSecret: "g5-terminal-second-restart-secret" },
      );
      await secondRestart.initializeAfterRestart(
        new UncertainStartSupervisor(),
      );
      await expect(
        secondRestartStore.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        executionId: reference.executionId,
        generation: reference.generation,
        candidateAvailable: true,
        finalOrdinal: 1,
        state: "recovering",
        workspaceClaim: "quarantined",
      });
    } finally {
      await secondRestartStore?.close();
      await restartedStore?.close();
      await fixture.close();
    }
  });

  it("keeps a live-ingress candidate acknowledged but untrusted after pending stop and restart", async () => {
    const fixture = await createDurableAdmissionFixture();
    let ingress: RuntimeWorkerIngress | undefined;
    let worker: RuntimeWorkerIngressClient | undefined;
    let restartedStore: SqliteDurableAdmissionStore | undefined;
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "g5-candidate-ack-cleanup-crash",
        agentId: "agent-a",
        instruction: "candidate acknowledgement is not terminal success",
      });
      const { reference } = await fixture.service.prepareForDispatch(
        submitted.task.taskId,
        "g5-candidate-ack-daemon-epoch",
      );
      await fixture.service.markExecutionRunning(reference);
      const stopSupervisor = {
        requests: [] as ExecutionReference[],
        revokeAndStop(value: ExecutionReference) {
          this.requests.push(value);
          return Promise.resolve({ kind: "pending" } as const);
        },
      };
      ingress = await RuntimeWorkerIngress.open({
        endpoint: join(fixture.directory, "g5-candidate-ack.sock"),
        reference,
        lifecycle: {
          persistQuestion: () => Promise.resolve(),
          waitForAcceptedAnswer: () => Promise.resolve({}),
          acknowledgeQuestionDelivery: () => Promise.resolve(),
          markQuestionDeliveryUnknown: () => Promise.resolve(),
          recordObservation: (observation) =>
            fixture.service
              .recordRuntimeObservation(submitted.task.taskId, observation)
              .then(() => undefined),
          stopAfterCandidate: async (value) => {
            const stop = await stopSupervisor.revokeAndStop(value);
            expect(stop.kind).toBe("pending");
          },
          quarantine: () => Promise.resolve(),
        },
      });
      worker = await RuntimeWorkerIngressClient.connect(ingress.session);
      await expect(
        worker.emit(
          encodeWorkerObservation({
            kind: "candidate",
            reference,
            ordinal: 1,
            finalOrdinal: 1,
            outcome: "succeeded",
            summary: "bounded candidate only",
            sessionReference: null,
          }),
          1,
          "candidate",
        ),
      ).resolves.toBeUndefined();
      expect(stopSupervisor.requests).toEqual([reference]);
      await expect(
        fixture.store.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        candidateAvailable: true,
        finalOrdinal: 1,
        state: "stopping",
        workspaceClaim: "held",
      });
      await expect(
        fixture.service.getTask(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({ result: null });

      worker.close();
      worker = undefined;
      await ingress.close();
      ingress = undefined;
      await fixture.store.close();
      restartedStore = await SqliteDurableAdmissionStore.open({
        databasePath: fixture.databasePath,
      });
      const restarted = new DurableAgentExecutionService(
        await AgentRegistry.create(
          fixture.registryConfiguration,
          restartedStore,
        ),
        restartedStore,
        { cursorSecret: "g5-candidate-ack-restart-secret" },
      );
      const recovery = new UncertainStartSupervisor();
      await restarted.initializeAfterRestart(recovery);
      expect(recovery.starts).toEqual([]);
      expect(recovery.reconciliations).toEqual([reference]);
      await expect(
        restarted.getTask(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        result: null,
        execution: {
          state: "recovering",
          candidateAvailable: true,
          quarantined: true,
        },
      });
    } finally {
      worker?.close();
      await ingress?.close();
      await restartedStore?.close();
      await fixture.close();
    }
  });

  it("retains one claimed Reference after an unavailable start response across repeated daemon restarts", async () => {
    const fixture = await createDurableAdmissionFixture();
    let firstRestart: SqliteDurableAdmissionStore | undefined;
    let secondRestart: SqliteDurableAdmissionStore | undefined;
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "g5-start-response-loss",
        agentId: "agent-a",
        instruction: "do not replay after an uncertain start response",
      });
      const initialSupervisor = new UncertainStartSupervisor();
      await expect(
        new ControlledRuntimeDispatcher(
          fixture.service,
          { dispatchAuthority: () => Promise.resolve("g5-launch-epoch") },
          initialSupervisor,
        ).dispatch(submitted.task.taskId),
      ).resolves.toEqual({ kind: "unavailable" });
      expect(initialSupervisor.starts).toHaveLength(1);
      const reference = initialSupervisor.starts[0];
      if (reference === undefined)
        throw new Error("start reference is missing");

      await fixture.store.close();
      firstRestart = await SqliteDurableAdmissionStore.open({
        databasePath: fixture.databasePath,
      });
      const firstService = new DurableAgentExecutionService(
        await AgentRegistry.create(fixture.registryConfiguration, firstRestart),
        firstRestart,
        { cursorSecret: "g5-launch-first-restart-secret" },
      );
      const firstRecovery = new UncertainStartSupervisor();
      await firstService.initializeAfterRestart(firstRecovery);
      expect(firstRecovery.starts).toEqual([]);
      expect(firstRecovery.reconciliations).toEqual([reference]);
      await expect(
        firstRestart.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        executionId: reference.executionId,
        generation: reference.generation,
        daemonEpoch: reference.daemonEpoch,
        state: "recovering",
        workspaceClaim: "quarantined",
      });

      await firstRestart.close();
      firstRestart = undefined;
      secondRestart = await SqliteDurableAdmissionStore.open({
        databasePath: fixture.databasePath,
      });
      const secondService = new DurableAgentExecutionService(
        await AgentRegistry.create(
          fixture.registryConfiguration,
          secondRestart,
        ),
        secondRestart,
        { cursorSecret: "g5-launch-second-restart-secret" },
      );
      const secondRecovery = new UncertainStartSupervisor();
      await secondService.initializeAfterRestart(secondRecovery);
      expect(secondRecovery.starts).toEqual([]);
      expect(secondRecovery.reconciliations).toEqual([reference]);
      await expect(
        secondRestart.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        executionId: reference.executionId,
        generation: reference.generation,
        daemonEpoch: reference.daemonEpoch,
        workspaceClaim: "quarantined",
      });
    } finally {
      await secondRestart?.close();
      await firstRestart?.close();
      await fixture.close();
    }
  });

  it("retains a launched Reference when the daemon crashes before the running acknowledgement", async () => {
    const fixture = await createDurableAdmissionFixture();
    let restartedStore: SqliteDurableAdmissionStore | undefined;
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "g5-launched-before-running-ack",
        agentId: "agent-a",
        instruction: "do not rerun after a successful start but lost ack",
      });
      const originalSupervisor = new RecordedStartedSupervisor();
      let signalAckReached: () => void = () => undefined;
      const ackReached = new Promise<void>((resolve) => {
        signalAckReached = resolve;
      });
      const lifecycle: ControlledRuntimeDispatchLifecycle = {
        prepareForDispatch: fixture.service.prepareForDispatch.bind(
          fixture.service,
        ),
        assertDispatchStartAllowed:
          fixture.service.assertDispatchStartAllowed.bind(fixture.service),
        markExecutionRunning: () => {
          signalAckReached();
          return new Promise(() => undefined);
        },
        quarantineAfterDispatch: fixture.service.quarantineAfterDispatch.bind(
          fixture.service,
        ),
        interruptRuntime: fixture.service.interruptRuntime.bind(
          fixture.service,
        ),
        commitVerifiedStop: fixture.service.commitVerifiedStop.bind(
          fixture.service,
        ),
        persistRuntimeQuestion: fixture.service.persistRuntimeQuestion.bind(
          fixture.service,
        ),
        waitForAcceptedQuestionAnswer:
          fixture.service.waitForAcceptedQuestionAnswer.bind(fixture.service),
        acknowledgeRuntimeQuestionDelivery:
          fixture.service.acknowledgeRuntimeQuestionDelivery.bind(
            fixture.service,
          ),
        markRuntimeQuestionDeliveryUnknown:
          fixture.service.markRuntimeQuestionDeliveryUnknown.bind(
            fixture.service,
          ),
        recordRuntimeObservation: fixture.service.recordRuntimeObservation.bind(
          fixture.service,
        ),
      };
      const dispatch = new ControlledRuntimeDispatcher(
        lifecycle,
        {
          dispatchAuthority: () =>
            Promise.resolve("g5-launched-before-ack-epoch"),
        },
        originalSupervisor,
      ).dispatch(submitted.task.taskId);
      await Promise.race([
        ackReached,
        dispatch.then(() => {
          throw new Error("dispatch must remain at the running ack barrier");
        }),
      ]);
      const reference = originalSupervisor.starts[0];
      if (reference === undefined) throw new Error("started Reference missing");
      expect(originalSupervisor.starts).toEqual([reference]);
      await expect(
        fixture.store.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        executionId: reference.executionId,
        generation: reference.generation,
        daemonEpoch: reference.daemonEpoch,
        state: "starting",
        workspaceClaim: "held",
      });

      // The daemon stops while the dispatcher is suspended at its durable ack.
      await fixture.store.close();
      restartedStore = await SqliteDurableAdmissionStore.open({
        databasePath: fixture.databasePath,
      });
      const restarted = new DurableAgentExecutionService(
        await AgentRegistry.create(
          fixture.registryConfiguration,
          restartedStore,
        ),
        restartedStore,
        { cursorSecret: "g5-launched-before-ack-restart-secret" },
      );
      const recovery = new RecordedStartedSupervisor();
      await restarted.initializeAfterRestart(recovery);
      expect(recovery.starts).toEqual([]);
      expect(recovery.reconciliations).toEqual([reference]);
      await expect(
        restartedStore.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        executionId: reference.executionId,
        generation: reference.generation,
        daemonEpoch: reference.daemonEpoch,
        state: "recovering",
        workspaceClaim: "quarantined",
      });
      await expect(
        restarted.getTask(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        taskId: submitted.task.taskId,
        result: null,
      });
    } finally {
      await restartedStore?.close();
      await fixture.close();
    }
  });

  it("retains the exact pre-launch claim across restart without starting a Runtime", async () => {
    const fixture = await createDurableAdmissionFixture();
    let restartedStore: SqliteDurableAdmissionStore | undefined;
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "g5-claim-before-launch-crash",
        agentId: "agent-a",
        instruction:
          "retain the pre-launch claim without replaying Runtime input",
      });
      const { reference } = await fixture.service.prepareForDispatch(
        submitted.task.taskId,
        "g5-claim-before-launch-daemon-epoch",
      );

      await expect(
        fixture.store.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        executionId: reference.executionId,
        generation: reference.generation,
        daemonEpoch: reference.daemonEpoch,
        state: "starting",
        workspaceClaim: "held",
      });

      await fixture.store.close();
      restartedStore = await SqliteDurableAdmissionStore.open({
        databasePath: fixture.databasePath,
      });
      const restarted = new DurableAgentExecutionService(
        await AgentRegistry.create(
          fixture.registryConfiguration,
          restartedStore,
        ),
        restartedStore,
        { cursorSecret: "g5-claim-before-launch-restart-secret" },
      );
      const recovery = new UncertainStartSupervisor();
      await restarted.initializeAfterRestart(recovery);

      expect(recovery.starts).toEqual([]);
      expect(recovery.reconciliations).toEqual([reference]);
      await expect(
        restartedStore.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        executionId: reference.executionId,
        generation: reference.generation,
        daemonEpoch: reference.daemonEpoch,
        state: "recovering",
        workspaceClaim: "quarantined",
      });
    } finally {
      await restartedStore?.close();
      await fixture.close();
    }
  });

  it("retains an exact claim through a reconciliation crash and second restart", async () => {
    const fixture = await createDurableAdmissionFixture();
    let firstRestartStore: SqliteDurableAdmissionStore | undefined;
    let secondRestartStore: SqliteDurableAdmissionStore | undefined;
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "g5-reconciliation-crash",
        agentId: "agent-a",
        instruction: "do not replay while recovery reconciliation crashes",
      });
      const { reference } = await fixture.service.prepareForDispatch(
        submitted.task.taskId,
        "g5-reconciliation-crash-daemon-epoch",
      );

      await fixture.store.close();
      firstRestartStore = await SqliteDurableAdmissionStore.open({
        databasePath: fixture.databasePath,
      });
      const firstRestart = new DurableAgentExecutionService(
        await AgentRegistry.create(
          fixture.registryConfiguration,
          firstRestartStore,
        ),
        firstRestartStore,
        { cursorSecret: "g5-reconciliation-crash-first-restart-secret" },
      );
      const crashingRecovery = new ThrowingRecoverySupervisor();
      await firstRestart.initializeAfterRestart(crashingRecovery);
      expect(crashingRecovery.reconciliations).toEqual([reference]);
      await expect(
        firstRestartStore.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        executionId: reference.executionId,
        generation: reference.generation,
        daemonEpoch: reference.daemonEpoch,
        state: "recovering",
        workspaceClaim: "quarantined",
      });

      await firstRestartStore.close();
      firstRestartStore = undefined;
      secondRestartStore = await SqliteDurableAdmissionStore.open({
        databasePath: fixture.databasePath,
      });
      const secondRestart = new DurableAgentExecutionService(
        await AgentRegistry.create(
          fixture.registryConfiguration,
          secondRestartStore,
        ),
        secondRestartStore,
        { cursorSecret: "g5-reconciliation-crash-second-restart-secret" },
      );
      const secondRecovery = new UncertainStartSupervisor();
      await secondRestart.initializeAfterRestart(secondRecovery);

      expect(secondRecovery.starts).toEqual([]);
      expect(secondRecovery.reconciliations).toEqual([reference]);
      await expect(
        secondRestart.getTask(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        result: null,
        execution: {
          executionId: reference.executionId,
          state: "recovering",
          candidateAvailable: false,
          quarantined: true,
        },
      });
      await expect(
        secondRestartStore.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        executionId: reference.executionId,
        generation: reference.generation,
        daemonEpoch: reference.daemonEpoch,
        workspaceClaim: "quarantined",
      });
    } finally {
      await secondRestartStore?.close();
      await firstRestartStore?.close();
      await fixture.close();
    }
  });

  it("preserves an accepted live-callback answer across original expiry and lets restart mark its missing acknowledgement delivery-unknown", async () => {
    let now = new Date("2026-09-12T08:00:00.000Z");
    const fixture = await createDurableAdmissionFixture({}, { now: () => now });
    let restartedStore: SqliteDurableAdmissionStore | undefined;
    let ingress: RuntimeWorkerIngress | undefined;
    let worker: RuntimeWorkerIngressClient | undefined;
    let daemonCrashed = false;
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "g5-question-callback-loss",
        agentId: "agent-a",
        instruction: "retain the first answer without callback replay",
        inputWaitSeconds: 1,
        executionLimitSeconds: 1,
      });
      const { reference } = await fixture.service.prepareForDispatch(
        submitted.task.taskId,
        "g5-question-daemon-epoch",
      );
      await fixture.service.markExecutionRunning(reference);
      const identity = {
        questionId: "g5-question-callback-loss-question",
        toolUseId: "g5-question-callback-loss-tool",
        requestId: "g5-question-callback-loss-request",
      };
      ingress = await RuntimeWorkerIngress.open({
        endpoint: join(fixture.directory, "g5-question-callback.sock"),
        reference,
        lifecycle: {
          persistQuestion: (question) =>
            fixture.service.persistRuntimeQuestion(
              submitted.task.taskId,
              question,
            ),
          waitForAcceptedAnswer: (value, question, signal) =>
            fixture.service.waitForAcceptedQuestionAnswer(
              value,
              question,
              signal,
            ),
          acknowledgeQuestionDelivery: (value, question) =>
            fixture.service.acknowledgeRuntimeQuestionDelivery(value, question),
          markQuestionDeliveryUnknown: (value, question) =>
            daemonCrashed
              ? Promise.resolve()
              : fixture.service.markRuntimeQuestionDeliveryUnknown(
                  value,
                  question,
                ),
          recordObservation: (observation) =>
            fixture.service
              .recordRuntimeObservation(submitted.task.taskId, observation)
              .then(() => undefined),
          stopAfterCandidate: () => Promise.resolve(),
          quarantine: () => Promise.resolve(),
        },
      });
      worker = await RuntimeWorkerIngressClient.connect(ingress.session);
      await worker.emit(
        encodeWorkerObservation({
          kind: "question",
          reference,
          ordinal: 1,
          ...identity,
          toolActivity: "none",
          questions: questionSchema,
        }),
        1,
        "question",
      );
      await expect(
        fixture.service.getTask(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        executionLimitSeconds: 1,
        execution: {
          accountingPhase: "pure_wait",
        },
      });

      const delivery = worker.waitForQuestionAnswer(identity);
      await fixture.service.reply(actor, {
        operationId: "g5-question-callback-loss-answer",
        taskId: submitted.task.taskId,
        questionId: identity.questionId,
        answer: { "Which color should be used?": "Blue" },
      });
      await expect(delivery).resolves.toEqual({
        "Which color should be used?": "Blue",
      });
      await expect(
        fixture.service.getTask(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        question: {
          questionId: identity.questionId,
          state: "accepted",
          delivery: "pending",
        },
        execution: {
          accountingPhase: "active",
        },
      });
      now = new Date("2026-09-12T08:00:02.000Z");
      await expect(
        fixture.store.getQuestionForDelivery({
          reference,
          ...identity,
          now: now.toISOString(),
        }),
      ).resolves.toMatchObject({
        state: "accepted",
        delivery: "pending",
        inputExpiryClosedAt: "2026-09-12T08:00:00.000Z",
      });
      daemonCrashed = true;
      await ingress.close();
      ingress = undefined;
      worker = undefined;
      await fixture.store.close();
      restartedStore = await SqliteDurableAdmissionStore.open({
        databasePath: fixture.databasePath,
      });
      const restarted = new DurableAgentExecutionService(
        await AgentRegistry.create(
          fixture.registryConfiguration,
          restartedStore,
        ),
        restartedStore,
        { cursorSecret: "g5-question-restart-secret", now: () => now },
      );
      await restarted.initializeAfterRestart();

      await expect(
        restarted.getTask(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        question: {
          questionId: identity.questionId,
          state: "accepted",
          delivery: "unknown",
        },
      });
      await expect(
        restartedStore.getQuestionForDelivery({
          reference,
          ...identity,
          now: now.toISOString(),
        }),
      ).resolves.toBeUndefined();
      await expect(
        restartedStore.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        state: "recovering",
        accountingPhase: "stopped",
      });
      await expect(
        restarted.acknowledgeRuntimeQuestionDelivery(reference, identity),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      await expect(
        restarted.reply(actor, {
          operationId: "g5-question-callback-loss-answer",
          taskId: submitted.task.taskId,
          questionId: identity.questionId,
          answer: { "Which color should be used?": "Blue" },
        }),
      ).resolves.toMatchObject({
        replayed: true,
        task: { question: { delivery: "unknown" } },
      });
    } finally {
      worker?.close();
      await ingress?.close();
      await restartedStore?.close();
      await fixture.close();
    }
  });

  it("reopens an acknowledged answer with its spent reserve and no callback replay", async () => {
    const fixture = await createDurableAdmissionFixture();
    let restartedStore: SqliteDurableAdmissionStore | undefined;
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "g5-question-acknowledged-restart",
        agentId: "agent-a",
        instruction: "restart after a durably acknowledged first answer",
      });
      const { reference } = await fixture.service.prepareForDispatch(
        submitted.task.taskId,
        "g5-question-acknowledged-daemon-epoch",
      );
      await fixture.service.markExecutionRunning(reference);
      const identity = {
        questionId: "g5-question-acknowledged-restart-question",
        toolUseId: "g5-question-acknowledged-restart-tool",
        requestId: "g5-question-acknowledged-restart-request",
      };
      await fixture.service.persistRuntimeQuestion(submitted.task.taskId, {
        reference,
        ...identity,
        ordinal: 1,
        toolActivity: "none",
        questions: questionSchema,
      });
      await fixture.service.reply(actor, {
        operationId: "g5-question-acknowledged-restart-answer",
        taskId: submitted.task.taskId,
        questionId: identity.questionId,
        answer: { "Which color should be used?": "Blue" },
      });
      await fixture.service.acknowledgeRuntimeQuestionDelivery(
        reference,
        identity,
      );
      await expect(
        fixture.store.probe("inspectDurability"),
      ).resolves.toMatchObject({
        reservationState: [
          { controlReceipts: 1, controlEvents: 2, controlBytes: 65_536 },
        ],
      });
      await fixture.store.close();
      restartedStore = await SqliteDurableAdmissionStore.open({
        databasePath: fixture.databasePath,
      });
      const restarted = new DurableAgentExecutionService(
        await AgentRegistry.create(
          fixture.registryConfiguration,
          restartedStore,
        ),
        restartedStore,
        { cursorSecret: "g5-question-acknowledged-restart-secret" },
      );
      const recoverySupervisor = new UncertainStartSupervisor();
      await restarted.initializeAfterRestart(recoverySupervisor);
      expect(recoverySupervisor.starts).toEqual([]);
      expect(recoverySupervisor.reconciliations).toEqual([reference]);
      await expect(
        restarted.getTask(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        result: null,
        question: {
          questionId: identity.questionId,
          state: "closed",
          delivery: "acknowledged",
        },
        execution: { state: "recovering", quarantined: true },
      });
      await expect(
        restartedStore.getQuestionForDelivery({
          reference,
          ...identity,
          now: "2026-09-12T08:00:00.000Z",
        }),
      ).resolves.toBeUndefined();
      await expect(
        restarted.reply(actor, {
          operationId: "g5-question-acknowledged-restart-answer",
          taskId: submitted.task.taskId,
          questionId: identity.questionId,
          answer: { "Which color should be used?": "Blue" },
        }),
      ).resolves.toMatchObject({ replayed: true });
      await expect(
        restartedStore.probe("inspectDurability"),
      ).resolves.toMatchObject({
        reservationState: [
          { controlReceipts: 1, controlEvents: 2, controlBytes: 65_536 },
        ],
      });
    } finally {
      await restartedStore?.close();
      await fixture.close();
    }
  });
});
