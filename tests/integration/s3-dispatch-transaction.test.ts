import { describe, expect, it } from "vitest";

import { ControlledRuntimeDispatcher } from "../../src/dispatcher/controlled-runtime-dispatcher.js";
import type {
  ExecutionSupervisor,
  ProtectedRuntimeLaunchDirective,
  RuntimeExecutionPolicy,
  RuntimeIngressDescriptor,
  SupervisorStartResult,
} from "../../src/core/execution-supervisor.js";
import type { ExecutionReference } from "../../src/core/types.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

const creator = { principalId: "principal-a" };

class FixtureLauncher {
  calls = 0;

  dispatchAuthority(): Promise<string | undefined> {
    this.calls += 1;
    return Promise.resolve("launcher-epoch-1");
  }
}

class RecordingSupervisor implements ExecutionSupervisor {
  calls: ExecutionReference[] = [];
  policies: (RuntimeExecutionPolicy | undefined)[] = [];
  stopCalls: ExecutionReference[] = [];
  reconcileCalls: ExecutionReference[] = [];

  constructor(
    private readonly duringStart: (
      reference: ExecutionReference,
    ) => Promise<void>,
  ) {}

  async start(
    reference: ExecutionReference,
    _ingress?: RuntimeIngressDescriptor,
    _continuation?: ProtectedRuntimeLaunchDirective,
    policy?: RuntimeExecutionPolicy,
  ): Promise<SupervisorStartResult> {
    this.calls.push(reference);
    this.policies.push(policy);
    await this.duringStart(reference);
    return { kind: "started", executionUnitId: "agentport-execution-fixture" };
  }

  revokeAndStop(reference: ExecutionReference) {
    this.stopCalls.push(reference);
    return Promise.resolve({ kind: "pending" } as const);
  }

  reconcile(reference: ExecutionReference) {
    this.reconcileCalls.push(reference);
    return Promise.resolve({
      kind: "running",
      executionUnitId: "agentport-execution-fixture",
    } as const);
  }
}

class UnavailableSupervisor implements ExecutionSupervisor {
  calls: ExecutionReference[] = [];

  start(reference: ExecutionReference): Promise<SupervisorStartResult> {
    this.calls.push(reference);
    return Promise.resolve({ kind: "unavailable" });
  }

  revokeAndStop() {
    return Promise.resolve({ kind: "pending" } as const);
  }

  reconcile(): never {
    throw new Error("not used by dispatch preparation");
  }
}

describe("S3-B production dispatch transaction", () => {
  it("commits the creator-authorized starting intent and claim before one Supervisor start", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const submitted = await fixture.service.submitTask(creator, {
        operationId: "s3-dispatch-transaction",
        agentId: "agent-a",
        instruction: "start only after the durable authorization commit",
      });
      const launcher = new FixtureLauncher();
      const supervisor = new RecordingSupervisor(async (reference) => {
        const duringStart = await fixture.service.getTask(creator, {
          taskId: submitted.task.taskId,
        });
        expect(duringStart).toMatchObject({
          state: "starting",
          execution: {
            state: "starting",
            executionId: reference.executionId,
          },
        });
      });
      const dispatcher = new ControlledRuntimeDispatcher(
        fixture.service,
        launcher,
        supervisor,
      );

      await expect(dispatcher.dispatch(submitted.task.taskId)).resolves.toEqual(
        {
          kind: "started",
        },
      );

      expect(launcher.calls).toBe(1);
      expect(supervisor.calls).toHaveLength(1);
      expect(supervisor.calls[0]).toMatchObject({
        daemonEpoch: "launcher-epoch-1",
        launchProfileId: "fixture-profile",
      });
      expect(supervisor.policies).toEqual([
        { executionLimitSeconds: 3_600, inputWaitSeconds: 86_400 },
      ]);
      await expect(
        fixture.service.getTask(creator, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        state: "running",
        execution: {
          state: "running",
        },
      });
    } finally {
      await fixture.close();
    }
  });

  it("quarantines the durable claim after an unavailable Supervisor start reply", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const submitted = await fixture.service.submitTask(creator, {
        operationId: "s3-dispatch-unavailable",
        agentId: "agent-a",
        instruction: "do not infer that a missing start reply means no start",
      });
      const supervisor = new UnavailableSupervisor();
      const dispatcher = new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher(),
        supervisor,
      );

      await expect(dispatcher.dispatch(submitted.task.taskId)).resolves.toEqual(
        {
          kind: "unavailable",
        },
      );

      expect(supervisor.calls).toHaveLength(1);
      await expect(
        fixture.service.getTask(creator, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        state: "recovering",
        execution: { state: "recovering", quarantined: true },
      });
    } finally {
      await fixture.close();
    }
  });

  it("permits exactly one Supervisor start when two dispatchers race for one Task", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const submitted = await fixture.service.submitTask(creator, {
        operationId: "s3-dispatch-race",
        agentId: "agent-a",
        instruction: "only one committed Reference may reach the Supervisor",
      });
      const supervisor = new RecordingSupervisor(() => Promise.resolve());
      const first = new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher(),
        supervisor,
      );
      const second = new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher(),
        supervisor,
      );

      const attempts = await Promise.allSettled([
        first.dispatch(submitted.task.taskId),
        second.dispatch(submitted.task.taskId),
      ]);

      expect(
        attempts.filter((attempt) => attempt.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        attempts.find((attempt) => attempt.status === "rejected"),
      ).toMatchObject({ reason: { code: "operation_conflict" } });
      expect(supervisor.calls).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("keeps a cancel-during-start winner stopping and revokes the late start", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const submitted = await fixture.service.submitTask(creator, {
        operationId: "s3-cancel-during-start",
        agentId: "agent-a",
        instruction:
          "a durable cancellation must fence a late start acknowledgement",
      });
      const supervisor = new RecordingSupervisor(async () => {
        await expect(
          fixture.service.cancelTask(creator, {
            operationId: "s3-cancel-during-start-request",
            taskId: submitted.task.taskId,
          }),
        ).resolves.toMatchObject({
          task: { state: "stopping", execution: { state: "stopping" } },
        });
      });
      const dispatcher = new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher(),
        supervisor,
      );

      await expect(dispatcher.dispatch(submitted.task.taskId)).resolves.toEqual(
        { kind: "indeterminate" },
      );

      expect(supervisor.stopCalls).toHaveLength(1);
      await expect(
        fixture.service.getTask(creator, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        state: "stopping",
        execution: {
          state: "stopping",
          stopReason: "cancellation",
          quarantined: false,
        },
      });
    } finally {
      await fixture.close();
    }
  });

  it("coordinates trusted stopping after a running cancellation commit", async () => {
    const stopCalls: ExecutionReference[] = [];
    const fixture = await createDurableAdmissionFixture(
      {},
      {
        stopRequester: {
          requestStop(reference) {
            stopCalls.push(reference);
            return Promise.resolve();
          },
        },
      },
    );
    try {
      const submitted = await fixture.service.submitTask(creator, {
        operationId: "s3-running-cancel",
        agentId: "agent-a",
        instruction:
          "persist cancellation before stopping the running execution",
      });
      const dispatcher = new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher(),
        new RecordingSupervisor(() => Promise.resolve()),
      );
      await dispatcher.dispatch(submitted.task.taskId);

      await expect(
        fixture.service.cancelTask(creator, {
          operationId: "s3-running-cancel-request",
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        task: { state: "stopping", execution: { state: "stopping" } },
      });
      await expect.poll(() => stopCalls).toHaveLength(1);
      expect(typeof stopCalls[0]?.executionId).toBe("string");
      expect(typeof stopCalls[0]?.generation).toBe("string");
    } finally {
      await fixture.close();
    }
  });

  it("publishes a candidate terminal result and releases its Workspace claim atomically", async () => {
    const fixture = await createDurableAdmissionFixture(
      {},
      {
        stopEvidenceVerifier: {
          verify(value) {
            return value as never;
          },
        },
      },
    );
    try {
      const submitted = await fixture.service.submitTask(creator, {
        operationId: "s3-terminal-completion",
        agentId: "agent-a",
        instruction: "release only after trusted terminal evidence",
      });
      const supervisor = new RecordingSupervisor(() => Promise.resolve());
      const dispatcher = new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher(),
        supervisor,
      );
      await dispatcher.dispatch(submitted.task.taskId);
      const reference = supervisor.calls[0];
      if (reference === undefined) throw new Error("Expected Supervisor start");
      await fixture.recordObservation(creator, {
        taskId: submitted.task.taskId,
        observation: {
          reference,
          kind: "candidate",
          ordinal: 1,
          finalOrdinal: 1,
          outcome: { kind: "completed", summary: "bounded terminal result" },
        },
      });

      await expect(
        fixture.service.commitVerifiedStop({
          platform: "linux-cgroup-v2",
          reference,
          executionUnitId: "agentport-execution-fixture",
          generationSealedAt: "2026-09-14T00:00:00.000Z",
          unitEmptyObservedAt: "2026-09-14T00:00:01.000Z",
        }),
      ).resolves.toMatchObject({
        replayed: false,
        task: { taskId: submitted.task.taskId, state: "completed" },
        execution: { workspaceClaim: "released" },
      });

      const successor = await fixture.service.submitTask(creator, {
        operationId: "s3-terminal-successor",
        agentId: "agent-a",
        instruction: "the released Workspace can accept a later execution",
      });
      await expect(dispatcher.dispatch(successor.task.taskId)).resolves.toEqual(
        { kind: "started" },
      );
    } finally {
      await fixture.close();
    }
  });

  it("rejects unverified terminal evidence and retains the stopping claim", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const submitted = await fixture.service.submitTask(creator, {
        operationId: "s3-terminal-unverified",
        agentId: "agent-a",
        instruction:
          "a structural Stop Evidence forgery cannot release a claim",
      });
      const supervisor = new RecordingSupervisor(() => Promise.resolve());
      const dispatcher = new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher(),
        supervisor,
      );
      await dispatcher.dispatch(submitted.task.taskId);
      const reference = supervisor.calls[0];
      if (reference === undefined) throw new Error("Expected Supervisor start");
      await fixture.recordObservation(creator, {
        taskId: submitted.task.taskId,
        observation: {
          reference,
          kind: "candidate",
          ordinal: 1,
          finalOrdinal: 1,
          outcome: { kind: "completed", summary: "candidate before stop" },
        },
      });

      await expect(
        fixture.service.commitVerifiedStop({
          platform: "linux-cgroup-v2",
          reference,
          executionUnitId: "forged-unit",
          generationSealedAt: "2026-09-14T00:00:00.000Z",
          unitEmptyObservedAt: "2026-09-14T00:00:01.000Z",
        }),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      await expect(
        fixture.service.getTask(creator, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        state: "stopping",
        execution: { quarantined: false, stopReason: "completion" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("rolls back the stop-to-terminal crash window without releasing its claim", async () => {
    const fixture = await createDurableAdmissionFixture(
      {},
      {
        stopEvidenceVerifier: {
          verify(value) {
            return value as never;
          },
        },
      },
    );
    try {
      const submitted = await fixture.service.submitTask(creator, {
        operationId: "s3-terminal-crash-window",
        agentId: "agent-a",
        instruction: "an interrupted terminal commit must retain the Workspace",
      });
      const supervisor = new RecordingSupervisor(() => Promise.resolve());
      const dispatcher = new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher(),
        supervisor,
      );
      await dispatcher.dispatch(submitted.task.taskId);
      const reference = supervisor.calls[0];
      if (reference === undefined) throw new Error("Expected Supervisor start");
      await fixture.recordObservation(creator, {
        taskId: submitted.task.taskId,
        observation: {
          reference,
          kind: "candidate",
          ordinal: 1,
          finalOrdinal: 1,
          outcome: { kind: "failed", summary: "bounded worker failure" },
        },
      });
      await fixture.store.probe("failNextCommit");
      const evidence = {
        platform: "linux-cgroup-v2",
        reference,
        executionUnitId: "agentport-execution-fixture",
        generationSealedAt: "2026-09-14T00:00:00.000Z",
        unitEmptyObservedAt: "2026-09-14T00:00:01.000Z",
      };

      await expect(
        fixture.service.commitVerifiedStop(evidence),
      ).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      await expect(
        fixture.service.getTask(creator, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        state: "stopping",
        result: null,
        execution: { stopReason: "completion", quarantined: false },
      });

      await expect(
        fixture.service.commitVerifiedStop(evidence),
      ).resolves.toMatchObject({
        task: {
          state: "failed",
          result: { kind: "failed", summary: "bounded worker failure" },
        },
        execution: { workspaceClaim: "released" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("does not dispatch a Task after its creator loses current authorization", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const submitted = await fixture.service.submitTask(creator, {
        operationId: "s3-dispatch-creator-revoked",
        agentId: "agent-a",
        instruction: "a revoked creator cannot leave an executable Task behind",
      });
      await fixture.registry.replace({
        ...fixture.registryConfiguration,
        principals: fixture.registryConfiguration.principals.map((principal) =>
          principal.principalId === creator.principalId
            ? { ...principal, active: false }
            : principal,
        ),
      });
      const supervisor = new RecordingSupervisor(() => Promise.resolve());
      const dispatcher = new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher(),
        supervisor,
      );

      await expect(
        dispatcher.dispatch(submitted.task.taskId),
      ).rejects.toMatchObject({
        code: "membership_revoked",
      });

      expect(supervisor.calls).toHaveLength(0);
      await expect(
        fixture.store.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("does not dispatch an existing Context under a replaced runtime binding", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const submitted = await fixture.service.submitTask(creator, {
        operationId: "s3-dispatch-binding-replaced",
        agentId: "agent-a",
        instruction: "retain the Context binding fixed at submission",
      });
      await fixture.registry.replace({
        ...fixture.registryConfiguration,
        agents: fixture.registryConfiguration.agents.map((agent) =>
          agent.agentId === "agent-a"
            ? {
                ...agent,
                configurationRevision: "fixture-config-2",
                runtimeDriver: "replacement-unreachable-driver",
                runtimeVersion: "2.0.0",
              }
            : agent,
        ),
      });

      await expect(
        fixture.service.prepareForDispatch(
          submitted.task.taskId,
          "launcher-epoch-replaced-binding",
        ),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      await expect(
        fixture.store.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toBeUndefined();
      await expect(
        fixture.service.getTask(creator, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({ state: "queued", execution: null });
    } finally {
      await fixture.close();
    }
  });

  it("moves a started dispatch to recovering without replay after daemon restart", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const submitted = await fixture.service.submitTask(creator, {
        operationId: "s3-dispatch-restart",
        agentId: "agent-a",
        instruction: "never replay this Runtime command after restart",
      });
      const supervisor = new RecordingSupervisor(() => Promise.resolve());
      const dispatcher = new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher(),
        supervisor,
      );
      await dispatcher.dispatch(submitted.task.taskId);

      await fixture.service.initializeAfterRestart();

      expect(supervisor.calls).toHaveLength(1);
      await expect(
        fixture.service.getTask(creator, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        state: "recovering",
        execution: {
          state: "recovering",
          quarantined: true,
          recoveryReason: "daemon_restart",
        },
      });
    } finally {
      await fixture.close();
    }
  });

  it("reconciles and fences persisted References after restart without replay", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const submitted = await fixture.service.submitTask(creator, {
        operationId: "s3-recovery-reconcile",
        agentId: "agent-a",
        instruction: "recovery must not replay this command",
      });
      const supervisor = new RecordingSupervisor(() => Promise.resolve());
      const dispatcher = new ControlledRuntimeDispatcher(
        fixture.service,
        new FixtureLauncher(),
        supervisor,
      );
      await dispatcher.dispatch(submitted.task.taskId);

      await fixture.service.initializeAfterRestart(supervisor);

      expect(supervisor.calls).toHaveLength(1);
      expect(supervisor.reconcileCalls).toHaveLength(1);
      expect(supervisor.stopCalls).toHaveLength(1);
      await expect(
        fixture.service.getTask(creator, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        state: "recovering",
        execution: { state: "recovering", quarantined: true },
      });
    } finally {
      await fixture.close();
    }
  });
});
