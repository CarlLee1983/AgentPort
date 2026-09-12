import { randomUUID } from "node:crypto";

import type {
  AgentRegistry,
  PrincipalAuthorization,
} from "../bootstrap/registry.js";
import {
  DurableAdmissionStoreError,
  type StoredEvent,
  type StoredTask,
} from "../storage/sqlite-durable-admission-store.js";
import { CursorCodec, operationFingerprint } from "./codec.js";
import { ApplicationError, type ApplicationErrorCode } from "./errors.js";
import type { DurableAdmissionStore } from "./ports.js";
import type {
  AgentExecutionService,
  AgentPage,
  CancelTaskInput,
  CredentialSubject,
  EventPage,
  GetEventsInput,
  GetTaskInput,
  ListAgentsInput,
  ListTasksInput,
  MutationResult,
  SubmitTaskInput,
  TaskEvent,
  TaskPage,
  TaskSnapshot,
  TaskSummary,
} from "./types.js";

export interface ServiceOptions {
  cursorSecret: string;
  now?: () => Date;
  newId?: () => string;
  snapshotCacheEntries?: number;
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

export class DurableAgentExecutionService implements AgentExecutionService {
  readonly #cursorCodec: CursorCodec;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #snapshotCacheEntries: number;
  readonly #snapshots = new Map<
    string,
    { accessScopeId: string; snapshot: TaskSnapshot }
  >();

  constructor(
    private readonly registry: AgentRegistry,
    private readonly store: DurableAdmissionStore,
    options: ServiceOptions,
  ) {
    this.#cursorCodec = new CursorCodec(options.cursorSecret);
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
    this.#snapshotCacheEntries = options.snapshotCacheEntries ?? 256;
    if (
      !Number.isSafeInteger(this.#snapshotCacheEntries) ||
      this.#snapshotCacheEntries < 1
    ) {
      throw new Error("snapshotCacheEntries must be a positive safe integer");
    }
  }

  async initializeAfterRestart(): Promise<void> {
    try {
      await this.store.transitionTasks({
        fromState: "queued",
        toState: "paused",
        reason: "daemon_restart",
        eventType: "daemon_restart_paused",
      });
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
    try {
      const result = await this.store.submit({
        accessScopeId: authorization.accessScopeId,
        operationId: input.operationId,
        fingerprint,
        principalId: authorization.principalId,
        expectedRegistryRevision,
        taskId: this.#newId(),
        contextId: this.#newId(),
        agentId: input.agentId,
        instruction: input.instruction,
        ...(input.executionLimitSeconds === undefined
          ? {}
          : { executionLimitSeconds: input.executionLimitSeconds }),
        ...(input.inputWaitSeconds === undefined
          ? {}
          : { inputWaitSeconds: input.inputWaitSeconds }),
        binding: {
          bindingSnapshotId: this.#newId(),
          configurationRevision: binding.configurationRevision,
          workspaceIdentity: { ...binding.workspace },
          runtimeDriver: binding.runtimeDriver,
          runtimeVersion: binding.runtimeVersion,
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
      const task = await this.store.getTask({
        accessScopeId: authorization.accessScopeId,
        allowedAgentIds: allowedAgentIds(authorization),
        taskId: input.taskId,
      });
      if (task === undefined) {
        throw new ApplicationError("not_found", "Resource not found");
      }
      const snapshot = this.#snapshot(task, "current");
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

  async #cancelTask(
    actor: CredentialSubject,
    input: CancelTaskInput,
  ): Promise<MutationResult> {
    const authorization = this.#authorize(actor);
    const expectedRegistryRevision = this.#mutationRevision(authorization);
    await this.#getCurrentTask(authorization, input.taskId);
    try {
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
      const task = await this.store.getTask({
        accessScopeId: authorization.accessScopeId,
        allowedAgentIds: allowedAgentIds(authorization),
        taskId,
      });
      if (task === undefined) {
        throw new ApplicationError("not_found", "Resource not found");
      }
      const snapshot = this.#snapshot(task, "current");
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
  ): TaskSnapshot {
    return {
      ...this.#summary(task),
      instruction: task.instruction,
      observedAt: this.#now().toISOString(),
      observationStatus,
    };
  }

  #summary(task: StoredTask): TaskSummary {
    return {
      taskId: task.taskId,
      contextId: task.contextId,
      agentId: task.agentId,
      state: task.state,
      reason: task.reason ?? null,
      revision: task.revision,
      queueOrder: task.queueOrder,
      executionLimitSeconds: task.executionLimitSeconds ?? null,
      inputWaitSeconds: task.inputWaitSeconds ?? null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  #event(event: StoredEvent): TaskEvent {
    return { ...event };
  }
}
