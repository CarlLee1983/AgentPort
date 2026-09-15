import { describe, expect, it } from "vitest";

import type {
  ExecutionSupervisor,
  SupervisorStartResult,
} from "../../src/core/execution-supervisor.js";
import { StorageIncidentCoordinator } from "../../src/bootstrap/storage-incident-coordinator.js";
import type { ExecutionReference } from "../../src/core/types.js";
import {
  ControlledRuntimeDispatcher,
  type RuntimeIngressFactory,
} from "../../src/dispatcher/controlled-runtime-dispatcher.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

class FixtureLauncher {
  calls = 0;

  dispatchAuthority(): Promise<string | undefined> {
    this.calls += 1;
    return Promise.resolve("storage-incident-epoch");
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

describe("S5 storage-failure convergence", () => {
  it("closes admission and dispatch before another start and stops every active Reference", async () => {
    const supervisor = new RecordingSupervisor();
    const incidents = new StorageIncidentCoordinator(supervisor, 4);
    const fixture = await createDurableAdmissionFixture(
      {},
      { storageIncidentSafety: incidents },
      incidents,
    );
    try {
      const running = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "storage-incident-running-submit",
          agentId: "agent-a",
          instruction: "remain controlled when durable storage fails",
        },
      );
      const secondRunning = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "storage-incident-second-running-submit",
          agentId: "agent-revokable",
          instruction: "also remain controlled when durable storage fails",
        },
      );
      const waiting = await fixture.service.submitTask(
        { principalId: "principal-b" },
        {
          operationId: "storage-incident-waiting-submit",
          agentId: "agent-b",
          instruction: "must not start after the storage incident",
        },
      );
      const launcher = new FixtureLauncher();
      const dispatcher = new ControlledRuntimeDispatcher(
        fixture.service,
        launcher,
        supervisor,
      );

      await expect(dispatcher.dispatch(running.task.taskId)).resolves.toEqual({
        kind: "started",
      });
      await expect(
        dispatcher.dispatch(secondRunning.task.taskId),
      ).resolves.toEqual({ kind: "started" });
      expect(supervisor.startCalls).toHaveLength(2);

      await fixture.store.probe("failNextCommit");
      await expect(
        fixture.service.submitTask(
          { principalId: "principal-a" },
          {
            operationId: "storage-incident-failing-submit",
            agentId: "agent-a",
            instruction: "this commit must not be reported as accepted",
          },
        ),
      ).rejects.toMatchObject({ code: "storage_unavailable" });

      await expect
        .poll(() => supervisor.stopCalls)
        .toEqual(supervisor.startCalls);
      await expect(
        fixture.service.submitTask(
          { principalId: "principal-a" },
          {
            operationId: "storage-incident-late-submit",
            agentId: "agent-a",
            instruction: "the latch must reject later admission",
          },
        ),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      await expect(
        dispatcher.dispatch(waiting.task.taskId),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      expect(supervisor.startCalls).toHaveLength(2);
      await expect(
        fixture.service.getTask(
          { principalId: "principal-a" },
          { taskId: running.task.taskId },
        ),
      ).resolves.toMatchObject({
        observationStatus: "stale",
        state: "queued",
        execution: null,
      });
    } finally {
      await fixture.close();
    }
  });

  it("treats a dispatch-time storage read timeout as an incident before another start", async () => {
    const supervisor = new RecordingSupervisor();
    const incidents = new StorageIncidentCoordinator(supervisor, 4);
    const fixture = await createDurableAdmissionFixture(
      { requestTimeoutMs: 50 },
      { storageIncidentSafety: incidents },
      incidents,
    );
    try {
      const running = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "storage-timeout-running-submit",
          agentId: "agent-a",
          instruction: "stop when dispatch storage becomes unresponsive",
        },
      );
      const waiting = await fixture.service.submitTask(
        { principalId: "principal-b" },
        {
          operationId: "storage-timeout-waiting-submit",
          agentId: "agent-b",
          instruction: "must never reach Supervisor start",
        },
      );
      const dispatcher = new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher(),
        supervisor,
      );
      await dispatcher.dispatch(running.task.taskId);
      const blocking = fixture.store.probe("block", 200).catch(() => undefined);

      await expect(
        dispatcher.dispatch(waiting.task.taskId),
      ).rejects.toMatchObject({ code: "observation_unavailable" });
      expect(incidents.isLatched()).toBe(true);
      await expect
        .poll(() => supervisor.stopCalls)
        .toEqual([supervisor.startCalls[0]]);
      await blocking;
      await new Promise((resolve) => setTimeout(resolve, 200));
      await expect(
        dispatcher.dispatch(waiting.task.taskId),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      expect(supervisor.startCalls).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("fences the final Supervisor start when an incident arrives while ingress opens", async () => {
    const supervisor = new RecordingSupervisor();
    const incidents = new StorageIncidentCoordinator(supervisor, 4);
    const fixture = await createDurableAdmissionFixture(
      {},
      { storageIncidentSafety: incidents },
      incidents,
    );
    try {
      const waiting = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "storage-ingress-race-waiting-submit",
          agentId: "agent-a",
          instruction: "never start after the incident linearizes",
        },
      );
      let ingressOpened!: () => void;
      const opened = new Promise<void>((resolve) => {
        ingressOpened = resolve;
      });
      let releaseIngress!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseIngress = resolve;
      });
      let ingressClosed = false;
      const ingressFactory: RuntimeIngressFactory = {
        async open() {
          ingressOpened();
          await release;
          return {
            session: {
              endpoint: "/tmp/storage-incident-ingress.sock",
              token: "storage-incident-ingress-token",
            },
            close() {
              ingressClosed = true;
              return Promise.resolve();
            },
          };
        },
      };
      const dispatcher = new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher(),
        supervisor,
        ingressFactory,
      );
      const dispatch = dispatcher.dispatch(waiting.task.taskId);
      await opened;

      await fixture.store.probe("failNextCommit");
      await expect(
        fixture.service.submitTask(
          { principalId: "principal-b" },
          {
            operationId: "storage-ingress-race-failing-submit",
            agentId: "agent-b",
            instruction: "linearize the storage incident",
          },
        ),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      releaseIngress();

      await expect(dispatch).resolves.toEqual({ kind: "indeterminate" });
      expect(supervisor.startCalls).toEqual([]);
      expect(supervisor.stopCalls.length).toBeGreaterThanOrEqual(1);
      expect(ingressClosed).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    ["SQLite write lock", "failNextStorageBusy", "storage_unavailable"],
    ["physical full", "failNextStorageFull", "storage_unavailable"],
    ["physical I/O", "failNextStorageIo", "storage_unavailable"],
  ] as const)(
    "classifies %s commit failure as a latched incident",
    async (_name, probe, expectedCode) => {
      const supervisor = new RecordingSupervisor();
      const incidents = new StorageIncidentCoordinator(supervisor, 4);
      const fixture = await createDurableAdmissionFixture(
        {},
        { storageIncidentSafety: incidents },
        incidents,
      );
      try {
        const running = await fixture.service.submitTask(
          { principalId: "principal-a" },
          {
            operationId: `${probe}-running-submit`,
            agentId: "agent-a",
            instruction: "stop after a physical storage failure",
          },
        );
        await new ControlledRuntimeDispatcher(
          fixture.service,
          new FixtureLauncher(),
          supervisor,
        ).dispatch(running.task.taskId);

        await fixture.store.probe(probe);
        await expect(
          fixture.service.submitTask(
            { principalId: "principal-b" },
            {
              operationId: `${probe}-failing-submit`,
              agentId: "agent-b",
              instruction: "this physical failure must roll back",
            },
          ),
        ).rejects.toMatchObject({ code: expectedCode });
        expect(incidents.isLatched()).toBe(true);
        await expect
          .poll(() => supervisor.stopCalls)
          .toEqual([supervisor.startCalls[0]]);
        await expect(
          fixture.service.submitTask(
            { principalId: "principal-b" },
            {
              operationId: `${probe}-later-submit`,
              agentId: "agent-b",
              instruction: "the latch must remain closed",
            },
          ),
        ).rejects.toMatchObject({ code: "storage_unavailable" });
      } finally {
        await fixture.close();
      }
    },
  );

  it("latches and stops active work when the physical control reserve is damaged", async () => {
    const supervisor = new RecordingSupervisor();
    const incidents = new StorageIncidentCoordinator(supervisor, 4);
    const fixture = await createDurableAdmissionFixture(
      {},
      { storageIncidentSafety: incidents },
      incidents,
    );
    try {
      const running = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "storage-reserve-running-submit",
          agentId: "agent-a",
          instruction: "retain the running claim after reserve failure",
        },
      );
      await new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher(),
        supervisor,
      ).dispatch(running.task.taskId);
      await fixture.store.probe("truncatePhysicalControlReserve");

      await expect(
        fixture.service.cancelTask(
          { principalId: "principal-a" },
          {
            operationId: "storage-reserve-failing-cancel",
            taskId: running.task.taskId,
          },
        ),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      expect(incidents.isLatched()).toBe(true);
      await expect
        .poll(() => supervisor.stopCalls)
        .toEqual([supervisor.startCalls[0]]);
      await expect(
        fixture.store.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: running.task.taskId,
        }),
      ).resolves.toMatchObject({ workspaceClaim: "held" });
    } finally {
      await fixture.close();
    }
  });

  it("latches and stops active work after unexpected storage worker loss", async () => {
    const supervisor = new RecordingSupervisor();
    const incidents = new StorageIncidentCoordinator(supervisor, 4);
    const fixture = await createDurableAdmissionFixture(
      {},
      { storageIncidentSafety: incidents },
      incidents,
    );
    try {
      const running = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "storage-worker-loss-running-submit",
          agentId: "agent-a",
          instruction: "stop after storage worker loss",
        },
      );
      await new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher(),
        supervisor,
      ).dispatch(running.task.taskId);

      await expect(fixture.store.probe("exitClean")).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      expect(incidents.isLatched()).toBe(true);
      await expect
        .poll(() => supervisor.stopCalls)
        .toEqual([supervisor.startCalls[0]]);
    } finally {
      await fixture.close();
    }
  });

  it("keeps a failed answer commit pending and never accepts its same-process retry", async () => {
    const supervisor = new RecordingSupervisor();
    const incidents = new StorageIncidentCoordinator(supervisor, 4);
    const fixture = await createDurableAdmissionFixture(
      {},
      { storageIncidentSafety: incidents },
      incidents,
    );
    try {
      const submitted = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "storage-question-submit",
          agentId: "agent-a",
          instruction: "ask before storage fails",
        },
      );
      const { reference } = await fixture.service.prepareForDispatch(
        submitted.task.taskId,
        "storage-question-epoch",
      );
      await fixture.service.markExecutionRunning(reference);
      await fixture.service.persistRuntimeQuestion(submitted.task.taskId, {
        reference,
        questionId: "storage-question",
        toolUseId: "storage-question-tool",
        requestId: "storage-question-request",
        ordinal: 1,
        toolActivity: "none",
        questions: [
          {
            question: "Continue?",
            header: "Continue",
            options: [
              { label: "Yes", description: "Continue execution" },
              { label: "No", description: "Keep waiting" },
            ],
            multiSelect: false,
          },
        ],
      });
      const reply = {
        operationId: "storage-question-reply",
        taskId: submitted.task.taskId,
        questionId: "storage-question",
        answer: { "Continue?": "Yes" },
      };

      await fixture.store.probe("failNextCommit");
      await expect(
        fixture.service.reply({ principalId: "principal-a" }, reply),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      await expect.poll(() => supervisor.stopCalls).toEqual([reference]);
      await expect(
        fixture.service.reply({ principalId: "principal-a" }, reply),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      await expect(
        fixture.service.getTask(
          { principalId: "principal-a" },
          { taskId: submitted.task.taskId },
        ),
      ).resolves.toMatchObject({
        observationStatus: "stale",
        state: "queued",
        question: null,
      });
      await expect(
        fixture.store.getTaskProjection({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        task: { state: "awaiting_input" },
        question: { state: "pending", delivery: "pending" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("keeps an accepted answer pending acknowledgement after storage loss without redelivery", async () => {
    const supervisor = new RecordingSupervisor();
    const incidents = new StorageIncidentCoordinator(supervisor, 4);
    const fixture = await createDurableAdmissionFixture(
      {},
      { storageIncidentSafety: incidents },
      incidents,
    );
    try {
      const submitted = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "storage-accepted-answer-submit",
          agentId: "agent-a",
          instruction: "retain the accepted answer across storage loss",
        },
      );
      const { reference } = await fixture.service.prepareForDispatch(
        submitted.task.taskId,
        "storage-accepted-answer-epoch",
      );
      await fixture.service.markExecutionRunning(reference);
      await fixture.service.persistRuntimeQuestion(submitted.task.taskId, {
        reference,
        questionId: "storage-accepted-answer-question",
        toolUseId: "storage-accepted-answer-tool",
        requestId: "storage-accepted-answer-request",
        ordinal: 1,
        toolActivity: "none",
        questions: [
          {
            question: "Continue?",
            header: "Continue",
            options: [
              { label: "Yes", description: "Continue execution" },
              { label: "No", description: "Keep waiting" },
            ],
            multiSelect: false,
          },
        ],
      });
      const reply = {
        operationId: "storage-accepted-answer-reply",
        taskId: submitted.task.taskId,
        questionId: "storage-accepted-answer-question",
        answer: { "Continue?": "Yes" },
      };
      await expect(
        fixture.service.reply({ principalId: "principal-a" }, reply),
      ).resolves.toMatchObject({
        replayed: false,
        task: { question: { state: "accepted", delivery: "pending" } },
      });

      await expect(fixture.store.probe("exitClean")).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      await expect.poll(() => supervisor.stopCalls).toEqual([reference]);
      await expect(
        fixture.service.reply({ principalId: "principal-a" }, reply),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      await expect(
        fixture.service.getTask(
          { principalId: "principal-a" },
          { taskId: submitted.task.taskId },
        ),
      ).resolves.toMatchObject({
        observationStatus: "stale",
        question: { state: "accepted", delivery: "pending" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("retains the running claim when cancellation cannot commit", async () => {
    const supervisor = new RecordingSupervisor();
    const incidents = new StorageIncidentCoordinator(supervisor, 4);
    const fixture = await createDurableAdmissionFixture(
      {},
      { storageIncidentSafety: incidents },
      incidents,
    );
    try {
      const submitted = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "storage-cancel-submit",
          agentId: "agent-a",
          instruction: "retain the claim unless cancellation commits",
        },
      );
      await new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher(),
        supervisor,
      ).dispatch(submitted.task.taskId);
      const reference = supervisor.startCalls[0];
      if (reference === undefined) throw new Error("Expected active Reference");

      await fixture.store.probe("failNextCommit");
      await expect(
        fixture.service.cancelTask(
          { principalId: "principal-a" },
          {
            operationId: "storage-cancel-failing-operation",
            taskId: submitted.task.taskId,
          },
        ),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      await expect.poll(() => supervisor.stopCalls).toEqual([reference]);
      await expect(
        fixture.store.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        state: "running",
        workspaceClaim: "held",
      });
    } finally {
      await fixture.close();
    }
  });

  it("does not publish a candidate-shaped observation when its commit fails", async () => {
    const supervisor = new RecordingSupervisor();
    const incidents = new StorageIncidentCoordinator(supervisor, 4);
    const fixture = await createDurableAdmissionFixture(
      {},
      { storageIncidentSafety: incidents },
      incidents,
    );
    try {
      const submitted = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "storage-candidate-submit",
          agentId: "agent-a",
          instruction: "never fabricate a candidate outcome",
        },
      );
      await new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher(),
        supervisor,
      ).dispatch(submitted.task.taskId);
      const reference = supervisor.startCalls[0];
      if (reference === undefined) throw new Error("Expected active Reference");

      await fixture.store.probe("failNextCommit");
      await expect(
        fixture.service.recordRuntimeObservation(submitted.task.taskId, {
          reference,
          kind: "candidate",
          ordinal: 1,
          finalOrdinal: 1,
          outcome: {
            kind: "completed",
            summary: "candidate-shaped-private-sentinel",
          },
        }),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      await expect.poll(() => supervisor.stopCalls).toEqual([reference]);
      await expect(
        fixture.store.getTaskProjection({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        task: { state: "running", result: null },
        execution: {
          state: "running",
          candidateAvailable: false,
          lastObservationOrdinal: 0,
          workspaceClaim: "held",
        },
      });
    } finally {
      await fixture.close();
    }
  });

  it("does not publish a candidate outcome or release its claim when terminal commit fails", async () => {
    const supervisor = new RecordingSupervisor();
    const incidents = new StorageIncidentCoordinator(supervisor, 4);
    const fixture = await createDurableAdmissionFixture(
      {},
      {
        stopEvidenceVerifier: { verify: (value) => value as never },
        storageIncidentSafety: incidents,
      },
      incidents,
    );
    try {
      const submitted = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "storage-terminal-submit",
          agentId: "agent-a",
          instruction: "publish only after the terminal transaction",
        },
      );
      await new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher(),
        supervisor,
      ).dispatch(submitted.task.taskId);
      const reference = supervisor.startCalls[0];
      if (reference === undefined) throw new Error("Expected active Reference");
      await fixture.recordObservation(
        { principalId: "principal-a" },
        {
          taskId: submitted.task.taskId,
          observation: {
            reference,
            kind: "candidate",
            ordinal: 1,
            finalOrdinal: 1,
            outcome: {
              kind: "completed",
              summary: "candidate-not-terminal-sentinel",
            },
          },
        },
      );
      const evidence = {
        platform: "linux-cgroup-v2",
        reference,
        executionUnitId: `unit-${reference.executionId}`,
        generationSealedAt: "2026-09-15T00:00:00.000Z",
        unitEmptyObservedAt: "2026-09-15T00:00:01.000Z",
      };

      await fixture.store.probe("failNextCommit");
      await expect(
        fixture.service.commitVerifiedStop(evidence),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      await expect.poll(() => supervisor.stopCalls).toEqual([reference]);
      await expect(
        fixture.store.getTaskProjection({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        task: { state: "stopping", result: null },
        execution: { state: "stopping", workspaceClaim: "held" },
      });
      await expect(
        fixture.service.commitVerifiedStop(evidence),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
    } finally {
      await fixture.close();
    }
  });
});
