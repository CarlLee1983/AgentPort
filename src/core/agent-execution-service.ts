import { randomUUID } from "node:crypto";

import type {
  AgentRegistry,
  PrincipalAuthorization,
} from "../bootstrap/registry.js";
import {
  DurableAdmissionStoreError,
  type StoredEvent,
  type StoredExecution,
  type StoredQuestion,
  type StoredTask,
  type StoredTerminalCommit,
  type TerminalStopEvidence,
} from "../storage/sqlite-durable-admission-store.js";
import { CursorCodec, operationFingerprint } from "./codec.js";
import { ApplicationError, type ApplicationErrorCode } from "./errors.js";
import type { DurableAdmissionStore } from "./ports.js";
import type {
  AgentExecutionService,
  AcknowledgeInterruptionInput,
  AgentPage,
  CancelTaskInput,
  CredentialSubject,
  EditTaskInput,
  EventPage,
  GetEventsInput,
  GetTaskInput,
  ListAgentsInput,
  ListTasksInput,
  MutationResult,
  ProtectedRuntimeLaunchDirective,
  ReplyInput,
  ResumeContextInput,
  RuntimeExecutionPolicy,
  RuntimeQuestionIdentity,
  ExecutionLifecycleSnapshot,
  ExecutionReference,
  SubmitTaskInput,
  TaskEvent,
  TaskPage,
  TaskSnapshot,
  TaskSummary,
} from "./types.js";

export interface RuntimeDispatchPreparation {
  reference: ExecutionReference;
  policy: RuntimeExecutionPolicy;
  continuation?: ProtectedRuntimeLaunchDirective;
}

export interface ServiceOptions {
  cursorSecret: string;
  now?: () => Date;
  monotonicNow?: () => number;
  newId?: () => string;
  snapshotCacheEntries?: number;
  /** Trusted production control seam; cancellation is persisted before it is requested. */
  stopRequester?: ExecutionStopRequestPort;
  stopEvidenceVerifier?: StopEvidenceVerifier;
}

/** Narrow internal control port; the core does not expose Supervisor operations to MCP. */
export interface ExecutionStopRequestPort {
  requestStop(reference: ExecutionReference): Promise<void>;
}

/** Local recovery port so platform-neutral composition cannot reach Supervisor code. */
export interface ExecutionRecoveryPort {
  reconcile(
    reference: ExecutionReference,
  ): Promise<{ kind: string; evidence?: unknown }>;
  revokeAndStop(
    reference: ExecutionReference,
  ): Promise<{ kind?: string; evidence?: unknown }>;
}

/** The platform control adapter vouches for evidence before core terminalization. */
export interface StopEvidenceVerifier {
  verify(value: unknown): TerminalStopEvidence | undefined;
}

export interface PlatformNeutralPreparationFixture {
  service: DurableAgentExecutionService;
  prepareExecution: (
    actor: CredentialSubject,
    input: { taskId: string },
  ) => Promise<{ executionId: string; state: "prepared" }>;
  recordIndeterminateSupervisorResult: (
    actor: CredentialSubject,
    input: { taskId: string; reference: ExecutionReference },
  ) => Promise<void>;
  executionReference: (
    actor: CredentialSubject,
    input: { taskId: string },
  ) => Promise<ExecutionReference>;
  recordObservation: (
    actor: CredentialSubject,
    input: { taskId: string; observation: unknown },
  ) => Promise<{ execution: ExecutionLifecycleSnapshot; replayed: boolean }>;
}

/**
 * Internal composition seam for S3-B dispatch. It deliberately exposes only
 * core-owned lifecycle transitions; it is not part of the MCP caller surface.
 */
export interface ControlledRuntimeDispatchLifecycle {
  prepareForDispatch(
    taskId: string,
    launcherDaemonEpoch: string,
  ): Promise<RuntimeDispatchPreparation>;
  markExecutionRunning(
    reference: ExecutionReference,
  ): Promise<{ kind: "running" } | { kind: "stop_required" }>;
  quarantineAfterDispatch(reference: ExecutionReference): Promise<void>;
  interruptRuntime(reference: ExecutionReference): Promise<void>;
  commitVerifiedStop(evidence: unknown): Promise<StoredTerminalCommit>;
  persistRuntimeQuestion(
    taskId: string,
    question: {
      reference: ExecutionReference;
      questionId: string;
      toolUseId: string;
      requestId: string;
      ordinal: number;
      toolActivity: "none";
      questions: unknown;
    },
  ): Promise<void>;
  waitForAcceptedQuestionAnswer(
    reference: ExecutionReference,
    identity: RuntimeQuestionIdentity,
    signal: AbortSignal,
  ): Promise<Record<string, string> | { kind: "input_timeout"; answer: null }>;
  acknowledgeRuntimeQuestionDelivery(
    reference: ExecutionReference,
    identity: RuntimeQuestionIdentity,
  ): Promise<void>;
  markRuntimeQuestionDeliveryUnknown(
    reference: ExecutionReference,
    identity: RuntimeQuestionIdentity,
  ): Promise<void>;
  recordRuntimeObservation(
    taskId: string,
    observation: unknown,
  ): Promise<{ execution: ExecutionLifecycleSnapshot; replayed: boolean }>;
}

const STORAGE_CODES = new Set<ApplicationErrorCode>([
  "not_found",
  "operation_conflict",
  "invalid_state",
  "queue_capacity",
  "tombstone_capacity",
  "storage_capacity",
  "storage_unavailable",
  "observation_unavailable",
]);

function isApplicationStorageCode(code: string): code is ApplicationErrorCode {
  return STORAGE_CODES.has(code as ApplicationErrorCode);
}

function storageError(error: unknown): ApplicationError {
  if (
    error instanceof DurableAdmissionStoreError &&
    isApplicationStorageCode(error.code)
  ) {
    return new ApplicationError(
      error.code,
      error.code === "not_found"
        ? "Resource not found"
        : "The requested operation could not be completed",
      { cause: error },
    );
  }
  return new ApplicationError(
    "storage_unavailable",
    "Durable storage is unavailable",
    { cause: error },
  );
}

function allowedAgentIds(
  authorization: PrincipalAuthorization,
): readonly string[] {
  return [...authorization.allowedAgentIds].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function waitForIngressAnswer(signal: AbortSignal): Promise<void> {
  let abort: (() => void) | undefined;
  const wait = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 50);
    abort = () => {
      clearTimeout(timer);
      reject(
        new ApplicationError("operation_conflict", "Question delivery stopped"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    timer.unref();
  });
  return wait.finally(() => {
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  });
}

export class DurableAgentExecutionService implements AgentExecutionService {
  readonly #cursorCodec: CursorCodec;
  readonly #now: () => Date;
  readonly #monotonicNow: () => number;
  readonly #newId: () => string;
  readonly #snapshotCacheEntries: number;
  readonly #daemonEpoch: string;
  readonly #stopRequester: ExecutionStopRequestPort | undefined;
  readonly #stopEvidenceVerifier: StopEvidenceVerifier | undefined;
  readonly #snapshots = new Map<
    string,
    { accessScopeId: string; snapshot: TaskSnapshot }
  >();
  readonly #activeAccountingStarted = new Map<string, number>();

  constructor(
    private readonly registry: AgentRegistry,
    private readonly store: DurableAdmissionStore,
    options: ServiceOptions,
  ) {
    this.#cursorCodec = new CursorCodec(options.cursorSecret);
    this.#now = options.now ?? (() => new Date());
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#newId = options.newId ?? randomUUID;
    this.#daemonEpoch = this.#newId();
    this.#snapshotCacheEntries = options.snapshotCacheEntries ?? 256;
    this.#stopRequester = options.stopRequester;
    this.#stopEvidenceVerifier = options.stopEvidenceVerifier;
    if (
      !Number.isSafeInteger(this.#snapshotCacheEntries) ||
      this.#snapshotCacheEntries < 1
    ) {
      throw new Error("snapshotCacheEntries must be a positive safe integer");
    }
  }

  /** Test-only composition for AP-003; production bootstrap never receives this capability. */
  static createPlatformNeutralPreparationFixture(
    registry: AgentRegistry,
    store: DurableAdmissionStore,
    options: ServiceOptions,
  ): PlatformNeutralPreparationFixture {
    const service = new DurableAgentExecutionService(registry, store, options);
    return {
      service,
      prepareExecution: (actor, input) =>
        service.#prepareExecution(actor, input),
      recordIndeterminateSupervisorResult: (actor, input) =>
        service.#recordIndeterminateSupervisorResult(actor, input),
      executionReference: (actor, input) =>
        service.#executionReference(actor, input),
      recordObservation: (actor, input) =>
        service.#recordObservation(actor, input),
    };
  }

  async initializeAfterRestart(
    recoverySupervisor?: ExecutionRecoveryPort,
  ): Promise<void> {
    try {
      await this.store.transitionTasks({
        fromState: "queued",
        toState: "paused",
        reason: "daemon_restart",
        eventType: "daemon_restart_paused",
      });
      const recovering = await this.store.recoverExecutions();
      if (recoverySupervisor === undefined) return;
      await Promise.all(
        recovering.map(async (execution) => {
          const reference: ExecutionReference = {
            executionId: execution.executionId,
            generation: execution.generation,
            daemonEpoch: execution.daemonEpoch,
            launchProfileId: execution.launchProfileId,
            workspaceIdentity: execution.workspaceId,
          };
          try {
            const reconciliation =
              await recoverySupervisor.reconcile(reference);
            let stoppedEvidence =
              reconciliation.kind === "stopped"
                ? reconciliation.evidence
                : undefined;
            if (reconciliation.kind === "running") {
              const stopped = await recoverySupervisor.revokeAndStop(reference);
              if (stopped.kind === "stopped") {
                stoppedEvidence = stopped.evidence;
              }
            }
            const verified =
              this.#stopEvidenceVerifier?.verify(stoppedEvidence);
            if (verified !== undefined) {
              await this.store.confirmRecoveryStopped({
                evidence: verified,
                now: this.#now().toISOString(),
              });
            }
          } catch {
            // Unknown external state stays durably recovering and quarantined.
          }
        }),
      );
    } catch (error) {
      throw storageError(error);
    }
  }

  async prepareForDispatch(
    taskId: string,
    launcherDaemonEpoch: string,
  ): Promise<RuntimeDispatchPreparation> {
    const task = await this.store.getTaskForDispatch(taskId);
    if (task === undefined) {
      throw new ApplicationError("not_found", "Resource not found");
    }
    if (task.createdBy === undefined) {
      throw new ApplicationError(
        "storage_unavailable",
        "Durable dispatch authorization is unavailable",
      );
    }
    const authorization = this.#authorize({ principalId: task.createdBy });
    if (
      authorization.accessScopeId !== task.accessScopeId ||
      authorization.getAgent(task.agentId) === undefined
    ) {
      throw new ApplicationError(
        "membership_revoked",
        "Current membership does not authorize this operation",
      );
    }
    const binding = authorization.getAgent(task.agentId);
    if (binding === undefined) {
      throw new ApplicationError("not_found", "Resource not found");
    }
    try {
      const execution = await this.store.claimAndPrepare({
        accessScopeId: authorization.accessScopeId,
        allowedAgentIds: allowedAgentIds(authorization),
        expectedRegistryRevision: this.#mutationRevision(authorization),
        executionId: this.#newId(),
        taskId,
        generation: this.#newId(),
        daemonEpoch: launcherDaemonEpoch,
        dispatchIntent: true,
        binding: {
          bindingSnapshotId: this.#newId(),
          accessScopeId: authorization.accessScopeId,
          agentId: task.agentId,
          workspaceIdentity: { ...binding.workspace },
          configurationRevision: binding.configurationRevision,
          runtimeDriver: binding.runtimeDriver,
          runtimeVersion: binding.runtimeVersion,
          launchProfileId: binding.launchProfileId,
          policy: binding.policy,
          createdAt: this.#now().toISOString(),
        },
      });
      this.#activeAccountingStarted.set(
        execution.executionId,
        this.#monotonicNow(),
      );
      return {
        reference: {
          executionId: execution.executionId,
          generation: execution.generation,
          daemonEpoch: execution.daemonEpoch,
          launchProfileId: execution.launchProfileId,
          workspaceIdentity: execution.workspaceId,
        },
        policy: {
          executionLimitSeconds:
            task.executionLimitSeconds ??
            Math.min(3_600, binding.policy.maximumExecutionLimitSeconds),
          inputWaitSeconds:
            task.inputWaitSeconds ??
            Math.min(86_400, binding.policy.maximumInputWaitSeconds),
        },
        ...(execution.launchContinuation === undefined
          ? {}
          : { continuation: execution.launchContinuation }),
      };
    } catch (error) {
      if (this.#isRegistryRevisionChange(error)) {
        throw this.#registryChanged(error);
      }
      throw storageError(error);
    }
  }

  async markExecutionRunning(
    reference: ExecutionReference,
  ): Promise<{ kind: "running" } | { kind: "stop_required" }> {
    try {
      const result = await this.store.markExecutionRunning({
        reference,
        now: this.#now().toISOString(),
      });
      if (result.kind === "running") {
        if (!this.#activeAccountingStarted.has(reference.executionId)) {
          this.#activeAccountingStarted.set(
            reference.executionId,
            this.#monotonicNow(),
          );
        }
      }
      return { kind: result.kind };
    } catch (error) {
      throw storageError(error);
    }
  }

  async quarantineAfterDispatch(reference: ExecutionReference): Promise<void> {
    try {
      await this.store.quarantineExecutionForDispatch({ reference });
    } catch (error) {
      throw storageError(error);
    }
  }

  async interruptRuntime(reference: ExecutionReference): Promise<void> {
    try {
      await this.store.interruptExecution({
        reference,
        activeElapsedMs: this.#activeElapsedMs(reference.executionId, true),
      });
      this.#activeAccountingStarted.delete(reference.executionId);
    } catch (error) {
      throw storageError(error);
    }
  }

  /** Internal ingress seam. Its socket is created only after the durable Reference exists. */
  async recordRuntimeObservation(
    taskId: string,
    observation: unknown,
  ): Promise<{ execution: ExecutionLifecycleSnapshot; replayed: boolean }> {
    try {
      const result = await this.store.commitRuntimeObservation({
        taskId,
        observation,
        now: this.#now().toISOString(),
      });
      return {
        execution: this.#executionSnapshot(result.execution),
        replayed: result.replayed,
      };
    } catch (error) {
      throw storageError(error);
    }
  }

  /**
   * Internal worker ingress seam. The core derives expiry from the durable
   * Task policy so a Runtime never supplies lifecycle time limits.
   */
  async persistRuntimeQuestion(
    taskId: string,
    question: {
      reference: ExecutionReference;
      questionId: string;
      toolUseId: string;
      requestId: string;
      ordinal: number;
      toolActivity: "none";
      questions: unknown;
    },
  ): Promise<void> {
    try {
      const task = await this.store.getTaskForDispatch(taskId);
      if (task === undefined) {
        throw new ApplicationError("operation_conflict", "Question is invalid");
      }
      const stamp = this.#now();
      const activeElapsedMs = this.#activeElapsedMs(
        question.reference.executionId,
      );
      const inputWaitSeconds = task.inputWaitSeconds ?? 86_400;
      await this.store.persistQuestionObservation({
        reference: question.reference,
        questionId: question.questionId,
        toolUseId: question.toolUseId,
        requestId: question.requestId,
        ordinal: question.ordinal,
        toolActivity: question.toolActivity,
        activeElapsedMs,
        schema: question.questions,
        expiresAt: new Date(
          stamp.getTime() + inputWaitSeconds * 1_000,
        ).toISOString(),
        now: stamp.toISOString(),
      });
      this.#activeAccountingStarted.delete(question.reference.executionId);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw storageError(error);
    }
  }

  /**
   * The ingress waits on a durable accepted answer; it never receives one
   * directly from an MCP Adapter or fabricates a continuation after failure.
   */
  async waitForAcceptedQuestionAnswer(
    reference: ExecutionReference,
    identity: RuntimeQuestionIdentity,
    signal: AbortSignal,
  ): Promise<Record<string, string> | { kind: "input_timeout"; answer: null }> {
    for (;;) {
      if (signal.aborted) {
        throw new ApplicationError(
          "operation_conflict",
          "Question delivery stopped",
        );
      }
      try {
        const question = await this.store.getQuestionForDelivery({
          reference,
          ...identity,
          now: this.#now().toISOString(),
        });
        if (question === undefined) {
          throw new ApplicationError(
            "operation_conflict",
            "Question delivery is unavailable",
          );
        }
        if (question.closureReason === "expired") {
          return { kind: "input_timeout", answer: null };
        }
        if (
          question.state === "accepted" &&
          question.delivery === "pending" &&
          question.answer !== null
        ) {
          return { ...question.answer };
        }
        if (question.state !== "pending" || question.delivery !== "pending") {
          throw new ApplicationError(
            "operation_conflict",
            "Question delivery is unavailable",
          );
        }
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw storageError(error);
      }
      await waitForIngressAnswer(signal);
    }
  }

  /** Trusted worker acknowledgement is the only path back to running. */
  async acknowledgeRuntimeQuestionDelivery(
    reference: ExecutionReference,
    identity: RuntimeQuestionIdentity,
  ): Promise<void> {
    try {
      await this.store.acknowledgeQuestionDelivery({
        reference,
        ...identity,
        now: this.#now().toISOString(),
      });
    } catch (error) {
      throw storageError(error);
    }
  }

  /** A lost worker must not receive an accepted answer a second time. */
  async markRuntimeQuestionDeliveryUnknown(
    reference: ExecutionReference,
    identity: RuntimeQuestionIdentity,
  ): Promise<void> {
    try {
      await this.store.markQuestionDeliveryUnknown({
        reference,
        ...identity,
        now: this.#now().toISOString(),
      });
    } catch (error) {
      throw storageError(error);
    }
  }

  /** Internal S3-B seam; MCP and worker protocol adapters do not receive it. */
  async commitVerifiedStop(evidence: unknown): Promise<StoredTerminalCommit> {
    const verified = this.#stopEvidenceVerifier?.verify(evidence);
    if (verified === undefined) {
      throw new ApplicationError(
        "operation_conflict",
        "Stop evidence is not trusted",
      );
    }
    try {
      const result = await this.store.commitTerminal({
        evidence: verified,
        activeElapsedMs: this.#activeElapsedMs(
          verified.reference.executionId,
          true,
        ),
      });
      this.#activeAccountingStarted.delete(verified.reference.executionId);
      return result;
    } catch (error) {
      throw storageError(error);
    }
  }

  listAgents(
    actor: CredentialSubject,
    input: ListAgentsInput,
  ): Promise<AgentPage> {
    try {
      const authorization = this.#authorize(actor);
      const limit = input.limit ?? 50;
      let afterAgentId = "";
      if (input.cursor !== undefined) {
        const cursor = this.#cursorCodec.decode(input.cursor);
        if (
          !isRecord(cursor) ||
          cursor["version"] !== 1 ||
          cursor["kind"] !== "agents" ||
          cursor["accessScopeId"] !== authorization.accessScopeId ||
          typeof cursor.afterAgentId !== "string"
        ) {
          throw new ApplicationError("not_found", "Resource not found");
        }
        afterAgentId = cursor.afterAgentId;
      }
      const visible = authorization
        .listAgents()
        .filter(({ descriptor }) => descriptor.agentId > afterAgentId);
      const page = visible.slice(0, limit);
      const last = page.at(-1)?.descriptor.agentId;
      return Promise.resolve({
        agents: page.map(({ descriptor }) => descriptor),
        nextCursor:
          visible.length > limit && last !== undefined
            ? this.#cursorCodec.encode({
                version: 1,
                kind: "agents",
                accessScopeId: authorization.accessScopeId,
                afterAgentId: last,
              })
            : null,
      });
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error("Agent listing failed"),
      );
    }
  }

  async submitTask(
    actor: CredentialSubject,
    input: SubmitTaskInput,
  ): Promise<MutationResult> {
    return this.#submitTask(actor, input);
  }

  async #submitTask(
    actor: CredentialSubject,
    input: SubmitTaskInput,
  ): Promise<MutationResult> {
    const authorization = this.#authorize(actor);
    const expectedRegistryRevision = this.#mutationRevision(authorization);
    const binding = authorization.getAgent(input.agentId);
    if (binding === undefined) {
      throw new ApplicationError("not_found", "Resource not found");
    }
    const fingerprint = operationFingerprint({
      version: 1,
      operation: "submit_task",
      agentId: input.agentId,
      instruction: input.instruction,
      contextId: input.contextId ?? null,
      executionLimitSeconds: input.executionLimitSeconds ?? null,
      inputWaitSeconds: input.inputWaitSeconds ?? null,
    });
    const executionLimitRejected =
      input.executionLimitSeconds !== undefined &&
      input.executionLimitSeconds > binding.policy.maximumExecutionLimitSeconds;
    const inputWaitRejected =
      input.inputWaitSeconds !== undefined &&
      input.inputWaitSeconds > binding.policy.maximumInputWaitSeconds;
    if (executionLimitRejected || inputWaitRejected) {
      try {
        const receipt = await this.store.lookupReceipt({
          accessScopeId: authorization.accessScopeId,
          operationId: input.operationId,
          operationType: "submit",
          fingerprint,
        });
        if (receipt !== undefined) {
          const task = await this.#getCurrentTask(
            authorization,
            receipt.taskId,
          );
          this.#remember(authorization.accessScopeId, task);
          return { task, replayed: true };
        }
      } catch (error) {
        throw await this.#mutationError(authorization, error);
      }
      throw new ApplicationError(
        "validation_error",
        "The request exceeds the configured Agent policy",
      );
    }

    const now = this.#now().toISOString();
    const executionLimitSeconds =
      input.executionLimitSeconds ??
      Math.min(3_600, binding.policy.maximumExecutionLimitSeconds);
    const inputWaitSeconds =
      input.inputWaitSeconds ??
      Math.min(86_400, binding.policy.maximumInputWaitSeconds);
    try {
      const result = await this.store.submit({
        accessScopeId: authorization.accessScopeId,
        operationId: input.operationId,
        fingerprint,
        principalId: authorization.principalId,
        expectedRegistryRevision,
        taskId: this.#newId(),
        contextId: this.#newId(),
        ...(input.contextId === undefined
          ? {}
          : { existingContextId: input.contextId }),
        agentId: input.agentId,
        instruction: input.instruction,
        executionLimitSeconds,
        inputWaitSeconds,
        binding: {
          bindingSnapshotId: this.#newId(),
          configurationRevision: binding.configurationRevision,
          workspaceIdentity: { ...binding.workspace },
          runtimeDriver: binding.runtimeDriver,
          runtimeVersion: binding.runtimeVersion,
          launchProfileId: binding.launchProfileId,
          policy: binding.policy,
        },
        now,
      });
      const task = result.replayed
        ? await this.#getCurrentTask(authorization, result.task.taskId)
        : this.#snapshot(result.task, "current");
      this.#remember(authorization.accessScopeId, task);
      return { task, replayed: result.replayed };
    } catch (error) {
      if (this.#isRegistryRevisionChange(error)) {
        throw this.#registryChanged(error);
      }
      throw await this.#mutationError(authorization, error);
    }
  }

  async getTask(
    actor: CredentialSubject,
    input: GetTaskInput,
  ): Promise<TaskSnapshot> {
    const authorization = this.#authorize(actor);
    try {
      const projection = await this.store.getTaskProjection({
        accessScopeId: authorization.accessScopeId,
        allowedAgentIds: allowedAgentIds(authorization),
        taskId: input.taskId,
      });
      if (projection === undefined) {
        throw new ApplicationError("not_found", "Resource not found");
      }
      const snapshot = this.#snapshot(
        projection.task,
        "current",
        projection.execution,
        projection.question,
      );
      this.#remember(authorization.accessScopeId, snapshot);
      return snapshot;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      const mapped = storageError(error);
      if (
        mapped.code === "observation_unavailable" ||
        mapped.code === "storage_unavailable"
      ) {
        const cached = this.#snapshots.get(input.taskId);
        if (
          cached !== undefined &&
          cached.accessScopeId === authorization.accessScopeId &&
          authorization.allowedAgentIds.has(cached.snapshot.agentId)
        ) {
          return {
            ...cached.snapshot,
            observedAt: this.#now().toISOString(),
            observationStatus: "stale",
          };
        }
      }
      throw mapped;
    }
  }

  async editTask(
    actor: CredentialSubject,
    input: EditTaskInput,
  ): Promise<MutationResult> {
    const authorization = this.#authorize(actor);
    const fingerprint = operationFingerprint({
      version: 1,
      operation: "edit_task",
      taskId: input.taskId,
      expectedRevision: input.expectedRevision,
      instruction: input.instruction,
    });
    try {
      const result = await this.store.edit({
        accessScopeId: authorization.accessScopeId,
        operationId: input.operationId,
        fingerprint,
        principalId: authorization.principalId,
        expectedRegistryRevision: this.#mutationRevision(authorization),
        allowedAgentIds: allowedAgentIds(authorization),
        taskId: input.taskId,
        expectedRevision: input.expectedRevision,
        instruction: input.instruction,
        now: this.#now().toISOString(),
      });
      const task = result.replayed
        ? await this.#getCurrentTask(authorization, result.task.taskId)
        : this.#snapshot(result.task, "current");
      this.#remember(authorization.accessScopeId, task);
      return { task, replayed: result.replayed };
    } catch (error) {
      if (this.#isRegistryRevisionChange(error)) {
        throw this.#registryChanged(error);
      }
      throw await this.#mutationError(authorization, error);
    }
  }

  async reply(
    actor: CredentialSubject,
    input: ReplyInput,
  ): Promise<MutationResult> {
    const authorization = this.#authorize(actor);
    const fingerprint = operationFingerprint({
      version: 1,
      operation: "reply",
      taskId: input.taskId,
      questionId: input.questionId,
      answer: input.answer,
    });
    try {
      const result = await this.store.replyToQuestion({
        accessScopeId: authorization.accessScopeId,
        allowedAgentIds: allowedAgentIds(authorization),
        expectedRegistryRevision: this.#mutationRevision(authorization),
        operationId: input.operationId,
        fingerprint,
        principalId: authorization.principalId,
        taskId: input.taskId,
        questionId: input.questionId,
        answer: input.answer,
        now: this.#now().toISOString(),
      });
      if (!result.replayed) {
        this.#activeAccountingStarted.set(
          result.question.executionId,
          this.#monotonicNow(),
        );
      }
      const task = this.#snapshot(
        result.task,
        "current",
        result.execution,
        result.question,
      );
      this.#remember(authorization.accessScopeId, task);
      return { task, replayed: result.replayed };
    } catch (error) {
      if (this.#isRegistryRevisionChange(error)) {
        throw this.#registryChanged(error);
      }
      throw await this.#mutationError(authorization, error);
    }
  }

  async resumeContext(
    actor: CredentialSubject,
    input: ResumeContextInput,
  ): Promise<MutationResult> {
    const authorization = this.#authorize(actor);
    const hasSummary = Object.hasOwn(input, "contextSummary");
    if (
      (input.continuationMode === "preserve" && hasSummary) ||
      (input.continuationMode === "fresh_session" && !hasSummary)
    ) {
      throw new ApplicationError(
        "validation_error",
        "The requested continuation is invalid",
      );
    }
    const fingerprint = operationFingerprint({
      version: 1,
      operation: "resume_context",
      contextId: input.contextId,
      expectedRevision: input.expectedRevision,
      continuationMode: input.continuationMode,
      ...(hasSummary ? { contextSummary: input.contextSummary } : {}),
    });
    try {
      const result = await this.store.resumeContext({
        accessScopeId: authorization.accessScopeId,
        operationId: input.operationId,
        fingerprint,
        principalId: authorization.principalId,
        expectedRegistryRevision: this.#mutationRevision(authorization),
        allowedAgentIds: allowedAgentIds(authorization),
        contextId: input.contextId,
        expectedRevision: input.expectedRevision,
        continuationMode: input.continuationMode,
        ...(hasSummary ? { contextSummary: input.contextSummary } : {}),
        now: this.#now().toISOString(),
      });
      const task = result.replayed
        ? await this.#getCurrentTask(authorization, result.task.taskId)
        : this.#snapshot(result.task, "current");
      this.#remember(authorization.accessScopeId, task);
      return { task, replayed: result.replayed };
    } catch (error) {
      if (this.#isRegistryRevisionChange(error)) {
        throw this.#registryChanged(error);
      }
      throw await this.#mutationError(authorization, error);
    }
  }

  async acknowledgeInterruption(
    actor: CredentialSubject,
    input: AcknowledgeInterruptionInput,
  ): Promise<MutationResult> {
    const authorization = this.#authorize(actor);
    try {
      const result = await this.store.acknowledgeInterruption({
        accessScopeId: authorization.accessScopeId,
        operationId: input.operationId,
        fingerprint: operationFingerprint({
          version: 1,
          operation: "acknowledge_interruption",
          taskId: input.taskId,
          expectedRevision: input.expectedRevision,
        }),
        principalId: authorization.principalId,
        expectedRegistryRevision: this.#mutationRevision(authorization),
        allowedAgentIds: allowedAgentIds(authorization),
        taskId: input.taskId,
        expectedRevision: input.expectedRevision,
        now: this.#now().toISOString(),
      });
      const task = await this.#getCurrentTask(
        authorization,
        result.task.taskId,
      );
      this.#remember(authorization.accessScopeId, task);
      return { task, replayed: result.replayed };
    } catch (error) {
      if (this.#isRegistryRevisionChange(error)) {
        throw this.#registryChanged(error);
      }
      throw await this.#mutationError(authorization, error);
    }
  }

  async listTasks(
    actor: CredentialSubject,
    input: ListTasksInput,
  ): Promise<TaskPage> {
    const authorization = this.#authorize(actor);
    if (
      input.agentId !== undefined &&
      authorization.getAgent(input.agentId) === undefined
    ) {
      throw new ApplicationError("not_found", "Resource not found");
    }
    const limit = input.limit ?? 50;
    let afterQueueOrder: number | undefined;
    if (input.cursor !== undefined) {
      const cursor = this.#cursorCodec.decode(input.cursor);
      if (
        !isRecord(cursor) ||
        cursor["version"] !== 1 ||
        cursor["kind"] !== "tasks" ||
        cursor["accessScopeId"] !== authorization.accessScopeId ||
        cursor["agentId"] !== (input.agentId ?? null) ||
        cursor["state"] !== (input.state ?? null) ||
        !Number.isSafeInteger(cursor["afterQueueOrder"])
      ) {
        throw new ApplicationError("not_found", "Resource not found");
      }
      afterQueueOrder = cursor["afterQueueOrder"] as number;
    }
    try {
      const result = await this.store.listTasks({
        accessScopeId: authorization.accessScopeId,
        allowedAgentIds: allowedAgentIds(authorization),
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(afterQueueOrder === undefined ? {} : { afterQueueOrder }),
        limit: limit + 1,
      });
      const hasMore = result.tasks.length > limit;
      const rows = result.tasks.slice(0, limit);
      const last = rows.at(-1)?.queueOrder;
      return {
        tasks: rows.map((task) => this.#summary(task)),
        nextCursor:
          hasMore && last !== undefined
            ? this.#cursorCodec.encode({
                version: 1,
                kind: "tasks",
                accessScopeId: authorization.accessScopeId,
                agentId: input.agentId ?? null,
                state: input.state ?? null,
                afterQueueOrder: last,
              })
            : null,
      };
    } catch (error) {
      throw storageError(error);
    }
  }

  async getEvents(
    actor: CredentialSubject,
    input: GetEventsInput,
  ): Promise<EventPage> {
    const authorization = this.#authorize(actor);
    if (input.taskId !== undefined) {
      await this.#getCurrentTask(authorization, input.taskId);
    }
    const limit = input.limit ?? 50;
    let afterCursor: number | undefined;
    if (input.afterCursor !== undefined) {
      const cursor = this.#cursorCodec.decode(input.afterCursor);
      if (
        !isRecord(cursor) ||
        cursor["version"] !== 1 ||
        cursor["kind"] !== "events" ||
        cursor["accessScopeId"] !== authorization.accessScopeId ||
        cursor["taskId"] !== (input.taskId ?? null) ||
        !Number.isSafeInteger(cursor["afterCursor"])
      ) {
        throw new ApplicationError("not_found", "Resource not found");
      }
      afterCursor = cursor["afterCursor"] as number;
    }
    try {
      const result = await this.store.getEvents({
        accessScopeId: authorization.accessScopeId,
        allowedAgentIds: allowedAgentIds(authorization),
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(afterCursor === undefined ? {} : { afterCursor }),
        limit: limit + 1,
      });
      const hasMore = result.events.length > limit;
      const rows = result.events.slice(0, limit);
      const last = rows.at(-1)?.cursor;
      return {
        events: rows.map((event) => this.#event(event)),
        nextCursor:
          hasMore && last !== undefined
            ? this.#cursorCodec.encode({
                version: 1,
                kind: "events",
                accessScopeId: authorization.accessScopeId,
                taskId: input.taskId ?? null,
                afterCursor: last,
              })
            : null,
      };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw storageError(error);
    }
  }

  async cancelTask(
    actor: CredentialSubject,
    input: CancelTaskInput,
  ): Promise<MutationResult> {
    return this.#cancelTask(actor, input);
  }

  async #prepareExecution(
    actor: CredentialSubject,
    input: { taskId: string },
  ): Promise<{ executionId: string; state: "prepared" }> {
    const authorization = this.#authorize(actor);
    const expectedRegistryRevision = this.#mutationRevision(authorization);
    const task = await this.#getCurrentTask(authorization, input.taskId);
    const binding = authorization.getAgent(task.agentId);
    if (binding === undefined) {
      throw new ApplicationError("not_found", "Resource not found");
    }
    try {
      const execution = await this.store.claimAndPrepare({
        accessScopeId: authorization.accessScopeId,
        allowedAgentIds: allowedAgentIds(authorization),
        expectedRegistryRevision,
        executionId: this.#newId(),
        taskId: task.taskId,
        generation: this.#newId(),
        daemonEpoch: this.#daemonEpoch,
        binding: {
          bindingSnapshotId: this.#newId(),
          accessScopeId: authorization.accessScopeId,
          agentId: task.agentId,
          workspaceIdentity: { ...binding.workspace },
          configurationRevision: binding.configurationRevision,
          runtimeDriver: binding.runtimeDriver,
          runtimeVersion: binding.runtimeVersion,
          launchProfileId: binding.launchProfileId,
          policy: binding.policy,
          createdAt: this.#now().toISOString(),
        },
      });
      return { executionId: execution.executionId, state: "prepared" };
    } catch (error) {
      if (this.#isRegistryRevisionChange(error)) {
        throw this.#registryChanged(error);
      }
      throw storageError(error);
    }
  }

  async #recordIndeterminateSupervisorResult(
    actor: CredentialSubject,
    input: { taskId: string; reference: ExecutionReference },
  ): Promise<void> {
    const authorization = this.#authorize(actor);
    try {
      const execution = await this.store.getExecution({
        accessScopeId: authorization.accessScopeId,
        allowedAgentIds: allowedAgentIds(authorization),
        taskId: input.taskId,
      });
      if (
        execution === undefined ||
        !this.#sameExecutionReference(execution, input.reference)
      ) {
        throw new ApplicationError(
          "operation_conflict",
          "Execution reference does not match the current lifecycle",
        );
      }
      await this.store.quarantineExecution({
        accessScopeId: authorization.accessScopeId,
        allowedAgentIds: allowedAgentIds(authorization),
        taskId: input.taskId,
      });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw storageError(error);
    }
  }

  async #executionReference(
    actor: CredentialSubject,
    input: { taskId: string },
  ): Promise<ExecutionReference> {
    const authorization = this.#authorize(actor);
    try {
      const execution = await this.store.getExecution({
        accessScopeId: authorization.accessScopeId,
        allowedAgentIds: allowedAgentIds(authorization),
        taskId: input.taskId,
      });
      if (execution === undefined) {
        throw new ApplicationError("not_found", "Resource not found");
      }
      return {
        executionId: execution.executionId,
        generation: execution.generation,
        daemonEpoch: execution.daemonEpoch,
        launchProfileId: execution.launchProfileId,
        workspaceIdentity: execution.workspaceId,
      };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw storageError(error);
    }
  }

  async #recordObservation(
    actor: CredentialSubject,
    input: { taskId: string; observation: unknown },
  ): Promise<{ execution: ExecutionLifecycleSnapshot; replayed: boolean }> {
    const authorization = this.#authorize(actor);
    const expectedRegistryRevision = this.#mutationRevision(authorization);
    try {
      const result = await this.store.commitExecutionObservation({
        accessScopeId: authorization.accessScopeId,
        allowedAgentIds: allowedAgentIds(authorization),
        expectedRegistryRevision,
        taskId: input.taskId,
        observation: input.observation,
        now: this.#now().toISOString(),
      });
      return {
        execution: this.#executionSnapshot(result.execution),
        replayed: result.replayed,
      };
    } catch (error) {
      if (this.#isRegistryRevisionChange(error)) {
        throw new ApplicationError(
          "operation_conflict",
          "Execution observation authorization changed before commit",
          { cause: error },
        );
      }
      throw storageError(error);
    }
  }

  #sameExecutionReference(
    execution: {
      executionId: string;
      generation: string;
      daemonEpoch: string;
      launchProfileId: string;
      workspaceId: string;
    },
    reference: ExecutionReference,
  ): boolean {
    return (
      execution.executionId === reference.executionId &&
      execution.generation === reference.generation &&
      execution.daemonEpoch === reference.daemonEpoch &&
      execution.launchProfileId === reference.launchProfileId &&
      execution.workspaceId === reference.workspaceIdentity
    );
  }

  #executionSnapshot(execution: StoredExecution): ExecutionLifecycleSnapshot {
    return {
      executionId: execution.executionId,
      taskId: execution.taskId,
      state: execution.state,
      progress: execution.progress,
      lastObservationOrdinal: execution.lastObservationOrdinal,
      candidateAvailable: execution.candidateAvailable,
      finalOrdinal: execution.finalOrdinal,
      stopReason: execution.stopReason,
      recoveryReason: execution.recoveryReason,
      accumulatedExecutionMs: execution.accumulatedExecutionMs,
      accountingPhase: execution.accountingPhase,
      accountingPhaseStartedAt: execution.accountingPhaseStartedAt,
      quarantined: execution.workspaceClaim === "quarantined",
      revision: execution.revision,
      observedAt: this.#now().toISOString(),
    };
  }

  #activeElapsedMs(executionId: string, allowMissing = false): number {
    const startedAt = this.#activeAccountingStarted.get(executionId);
    if (startedAt === undefined) {
      if (allowMissing) return 0;
      throw new ApplicationError(
        "operation_conflict",
        "Execution accounting state is unavailable",
      );
    }
    const current = this.#monotonicNow();
    if (!Number.isFinite(current) || current < startedAt) {
      throw new ApplicationError(
        "operation_conflict",
        "Execution accounting state is unavailable",
      );
    }
    return Math.floor(current - startedAt);
  }

  async #cancelTask(
    actor: CredentialSubject,
    input: CancelTaskInput,
  ): Promise<MutationResult> {
    const authorization = this.#authorize(actor);
    const expectedRegistryRevision = this.#mutationRevision(authorization);
    try {
      const activeExecution = await this.store.getExecution({
        accessScopeId: authorization.accessScopeId,
        allowedAgentIds: allowedAgentIds(authorization),
        taskId: input.taskId,
      });
      const result = await this.store.cancel({
        accessScopeId: authorization.accessScopeId,
        allowedAgentIds: allowedAgentIds(authorization),
        principalId: authorization.principalId,
        expectedRegistryRevision,
        operationId: input.operationId,
        fingerprint: operationFingerprint({
          version: 1,
          operation: "cancel_task",
          taskId: input.taskId,
        }),
        taskId: input.taskId,
        expectedStates: ["queued", "paused"],
        nextState: "canceled",
        eventType: "canceled",
        now: this.#now().toISOString(),
        activeElapsedMs:
          activeExecution === undefined
            ? 0
            : this.#activeElapsedMs(activeExecution.executionId, true),
      });
      if (activeExecution !== undefined) {
        this.#activeAccountingStarted.delete(activeExecution.executionId);
      }
      const task = await this.#getCurrentTask(
        authorization,
        result.task.taskId,
      );
      const execution =
        task.execution?.state !== "stopping"
          ? undefined
          : await this.store.getExecution({
              accessScopeId: authorization.accessScopeId,
              allowedAgentIds: allowedAgentIds(authorization),
              taskId: result.task.taskId,
            });
      if (execution?.stopReason === "cancellation") {
        this.#coordinateCancellation(execution);
      }
      this.#remember(authorization.accessScopeId, task);
      return { task, replayed: result.replayed };
    } catch (error) {
      if (this.#isRegistryRevisionChange(error)) {
        throw this.#registryChanged(error);
      }
      const mapped = storageError(error);
      if (
        mapped.code === "operation_conflict" &&
        error instanceof DurableAdmissionStoreError &&
        error.taskId !== undefined
      ) {
        let task: TaskSnapshot | undefined;
        try {
          task = await this.#getCurrentTask(authorization, error.taskId);
        } catch {
          // Do not attach a snapshot that current authorization cannot read.
        }
        if (task !== undefined) {
          throw new ApplicationError(mapped.code, mapped.message, {
            cause: mapped,
            task,
          });
        }
      }
      if (mapped.code === "invalid_state") {
        let task: TaskSnapshot | undefined;
        try {
          task = await this.#getCurrentTask(authorization, input.taskId);
        } catch {
          // The sanitized conflict remains useful if the fresh snapshot vanished.
        }
        if (task !== undefined) {
          throw new ApplicationError(mapped.code, mapped.message, {
            cause: mapped,
            task,
          });
        }
      }
      throw mapped;
    }
  }

  #coordinateCancellation(execution: StoredExecution): void {
    if (this.#stopRequester === undefined) return;
    void this.#stopRequester
      .requestStop({
        executionId: execution.executionId,
        generation: execution.generation,
        daemonEpoch: execution.daemonEpoch,
        launchProfileId: execution.launchProfileId,
        workspaceIdentity: execution.workspaceId,
      })
      .catch(() => {
        // The durable stopping claim remains until a trusted terminal transaction exists.
      });
  }

  #authorize(actor: CredentialSubject): PrincipalAuthorization {
    const authorization = this.registry.authorize(actor.principalId);
    if (authorization === undefined) {
      throw new ApplicationError(
        "membership_revoked",
        "Current membership does not authorize this operation",
      );
    }
    return authorization;
  }

  #mutationRevision(authorization: PrincipalAuthorization): number {
    if (authorization.registryRevision === undefined) {
      throw new ApplicationError(
        "storage_unavailable",
        "Durable mutation admission is unavailable",
      );
    }
    return authorization.registryRevision;
  }

  #isRegistryRevisionChange(
    error: unknown,
  ): error is DurableAdmissionStoreError {
    return (
      error instanceof DurableAdmissionStoreError &&
      error.code === "authorization_changed"
    );
  }

  #registryChanged(error: DurableAdmissionStoreError): ApplicationError {
    return new ApplicationError(
      "storage_unavailable",
      "Durable mutation admission changed authorization configuration",
      { cause: error },
    );
  }

  async #mutationError(
    authorization: PrincipalAuthorization,
    error: unknown,
  ): Promise<ApplicationError> {
    const mapped = storageError(error);
    if (
      mapped.code === "operation_conflict" &&
      error instanceof DurableAdmissionStoreError &&
      error.taskId !== undefined
    ) {
      try {
        const task = await this.#getCurrentTask(authorization, error.taskId);
        return new ApplicationError(mapped.code, mapped.message, {
          cause: mapped,
          task,
        });
      } catch {
        // Do not attach a snapshot that current authorization cannot read.
      }
    }
    return mapped;
  }

  async #getCurrentTask(
    authorization: PrincipalAuthorization,
    taskId: string,
  ): Promise<TaskSnapshot> {
    try {
      const projection = await this.store.getTaskProjection({
        accessScopeId: authorization.accessScopeId,
        allowedAgentIds: allowedAgentIds(authorization),
        taskId,
      });
      if (projection === undefined) {
        throw new ApplicationError("not_found", "Resource not found");
      }
      const snapshot = this.#snapshot(
        projection.task,
        "current",
        projection.execution,
        projection.question,
      );
      this.#remember(authorization.accessScopeId, snapshot);
      return snapshot;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw storageError(error);
    }
  }

  #remember(accessScopeId: string, snapshot: TaskSnapshot): void {
    this.#snapshots.delete(snapshot.taskId);
    this.#snapshots.set(snapshot.taskId, { accessScopeId, snapshot });
    while (this.#snapshots.size > this.#snapshotCacheEntries) {
      const oldest = this.#snapshots.keys().next().value;
      if (oldest === undefined) break;
      this.#snapshots.delete(oldest);
    }
  }

  #snapshot(
    task: StoredTask,
    observationStatus: TaskSnapshot["observationStatus"],
    execution: StoredExecution | null = null,
    question: StoredQuestion | null = null,
  ): TaskSnapshot {
    return {
      ...this.#summary(task),
      instruction: task.instruction,
      observedAt: this.#now().toISOString(),
      observationStatus,
      executionLiveness: "unknown",
      livenessCheckedAt: null,
      toolActivityStatus: question?.toolActivityStatus ?? "unknown",
      toolActivityObservedAt: question?.toolActivityObservedAt ?? null,
      toolActivityEvidence:
        question?.toolActivityStatus === "idle" &&
        question.toolActivityObservedAt !== null
          ? {
              toolName: "AskUserQuestion",
              startedAt: question.toolActivityObservedAt,
            }
          : null,
      execution: execution === null ? null : this.#executionSnapshot(execution),
      question: question === null ? null : this.#questionSnapshot(question),
      readiness: { status: "blocked", reason: "g1_unproven" },
    };
  }

  #questionSnapshot(question: StoredQuestion): TaskSnapshot["question"] {
    return {
      questionId: question.questionId,
      schema: question.schema,
      state: question.state,
      delivery: question.delivery,
      answer: question.answer,
      acceptedAt: question.acceptedAt,
      expiresAt: question.expiresAt,
      deliveryAcknowledgedAt: question.deliveryAcknowledgedAt,
      deliveryUnknownAt: question.deliveryUnknownAt,
      inputExpiryClosedAt: question.inputExpiryClosedAt,
      closedAt: question.closedAt,
      closureReason: question.closureReason,
      createdAt: question.createdAt,
    };
  }

  #summary(task: StoredTask): TaskSummary {
    return {
      taskId: task.taskId,
      contextId: task.contextId,
      contextRevision: task.contextRevision,
      predecessorTaskId: task.predecessorTaskId ?? null,
      blocker: task.blocker,
      continuation: task.continuation,
      agentId: task.agentId,
      state: task.state,
      reason: task.reason ?? null,
      revision: task.revision,
      queueOrder: task.queueOrder,
      executionLimitSeconds: task.executionLimitSeconds ?? null,
      inputWaitSeconds: task.inputWaitSeconds ?? null,
      result: task.result,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  #event(event: StoredEvent): TaskEvent {
    return { ...event };
  }
}
