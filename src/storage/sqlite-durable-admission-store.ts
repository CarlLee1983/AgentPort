import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Worker } from "node:worker_threads";
import type { BindingSnapshotRecord } from "../core/types.js";

export type StoredTaskState = "queued" | "paused" | "canceled";

export interface StoredTask {
  taskId: string;
  contextId: string;
  accessScopeId: string;
  agentId: string;
  state: StoredTaskState;
  revision: number;
  queueOrder: number;
  instruction: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  reason?: string | null;
  executionLimitSeconds?: number | null;
  inputWaitSeconds?: number | null;
}

export interface StoredExecution {
  executionId: string;
  taskId: string;
  generation: string;
  daemonEpoch: string;
  launchProfileId: string;
  workspaceId: string;
  state: "prepared" | "recovering";
  workspaceClaim: "held" | "quarantined";
  candidateOutcome: null;
  revision: number;
}

export interface ClaimAndPrepareExecutionRequest {
  accessScopeId: string;
  allowedAgentIds: readonly string[];
  expectedRegistryRevision: number;
  executionId: string;
  taskId: string;
  generation: string;
  daemonEpoch: string;
}

export interface StoredEvent {
  cursor: number;
  taskId: string;
  taskSeq: number;
  agentId: string;
  type: "accepted" | "daemon_restart_paused" | "canceled";
  taskRevision: number;
  occurredAt: string;
}

export type StoredMutationResult =
  | { task: StoredTask; replayed: false }
  | { task: Pick<StoredTask, "taskId">; replayed: true };

export interface StoreFailure {
  code:
    | "operation_conflict"
    | "invalid_state"
    | "queue_capacity"
    | "tombstone_capacity"
    | "storage_capacity"
    | "storage_unavailable"
    | "observation_unavailable"
    | "authorization_changed"
    | "not_found";
  message: string;
  taskId?: string;
}

export class DurableAdmissionStoreError extends Error {
  readonly code: StoreFailure["code"];
  readonly taskId?: string;
  constructor(failure: StoreFailure) {
    super(failure.message);
    this.code = failure.code;
    if (failure.taskId !== undefined) this.taskId = failure.taskId;
  }
}

export interface DurableAdmissionStoreOptions {
  databasePath: string;
  auditCapacity?: number;
  queuePerWorkspace?: number;
  queueGlobal?: number;
  receiptCapacity?: number;
  admissionBytes?: number;
  physicalAdmissionBytes?: number;
  physicalControlReserveBytes?: number;
  taskControlReserveBytes?: number;
  controlReceiptReserve?: number;
  controlEventReserve?: number;
  busyTimeoutMs?: number;
  requestTimeoutMs?: number;
}

const positiveIntegerOptions = [
  "auditCapacity",
  "queuePerWorkspace",
  "queueGlobal",
  "receiptCapacity",
  "admissionBytes",
  "physicalAdmissionBytes",
  "physicalControlReserveBytes",
  "taskControlReserveBytes",
  "controlReceiptReserve",
  "controlEventReserve",
  "busyTimeoutMs",
  "requestTimeoutMs",
] as const satisfies readonly (keyof DurableAdmissionStoreOptions)[];

export interface SanitizedAuditRecord {
  principalId: string | null;
  method: string;
  toolName: string | null;
  protocolVersion: string | null;
  clientName: string | null;
  clientVersion: string | null;
  clientCapabilitiesJson: string | null;
  resultCode: string;
  createdAt: string;
}

export interface StoredAuditRecord extends SanitizedAuditRecord {
  sequence: number;
}

export interface ProductAuditSnapshot {
  records: StoredAuditRecord[];
  overwrittenCount: number;
}

function validateOptions(options: DurableAdmissionStoreOptions): void {
  for (const name of positiveIntegerOptions) {
    const value = options[name];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (
    options.controlEventReserve !== undefined &&
    options.controlEventReserve < 2
  ) {
    throw new TypeError(
      "controlEventReserve must reserve restart and cancellation events",
    );
  }
  const queueGlobal = options.queueGlobal ?? 256;
  const physicalControlReserveBytes =
    options.physicalControlReserveBytes ?? 256 * 1024 * 1024;
  const physicalAdmissionBytes =
    options.physicalAdmissionBytes ?? 2 * 1024 * 1024 * 1024;
  if (
    !Number.isSafeInteger(physicalAdmissionBytes + physicalControlReserveBytes)
  ) {
    throw new TypeError("physical capacity boundary must be a safe integer");
  }
  const taskControlReserveBytes = options.taskControlReserveBytes ?? 128 * 1024;
  const maximumTaskControlReserve = taskControlReserveBytes * queueGlobal;
  if (
    taskControlReserveBytes < 3 ||
    !Number.isSafeInteger(maximumTaskControlReserve) ||
    maximumTaskControlReserve > physicalControlReserveBytes
  ) {
    throw new TypeError(
      "physicalControlReserveBytes must cover every queued Task reserve",
    );
  }
}

export interface SubmitStoredTaskRequest {
  accessScopeId: string;
  operationId: string;
  fingerprint: string;
  taskId: string;
  contextId: string;
  agentId: string;
  instruction: string;
  principalId: string;
  expectedRegistryRevision?: number;
  executionLimitSeconds?: number;
  inputWaitSeconds?: number;
  binding: Pick<
    BindingSnapshotRecord,
    | "bindingSnapshotId"
    | "configurationRevision"
    | "workspaceIdentity"
    | "runtimeDriver"
    | "runtimeVersion"
    | "policy"
  >;
  now?: string;
}

export interface CancelStoredTaskRequest {
  accessScopeId: string;
  operationId: string;
  fingerprint: string;
  taskId: string;
  principalId: string;
  expectedRegistryRevision?: number;
  allowedAgentIds?: readonly string[];
  expectedStates: readonly StoredTaskState[];
  nextState: StoredTaskState;
  eventType: StoredEvent["type"];
  now?: string;
}

export interface TransitionStoredTasksRequest {
  fromState: StoredTaskState;
  toState: StoredTaskState;
  reason: string;
  eventType: StoredEvent["type"];
}

export interface LookupStoredReceiptRequest {
  accessScopeId: string;
  operationId: string;
  operationType: "submit" | "cancel";
  targetId?: string;
  fingerprint: string;
}

interface Pending {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer?: NodeJS.Timeout;
}

interface QueuedAudit {
  record: SanitizedAuditRecord;
  resolve(): void;
  reject(reason: unknown): void;
}

interface AuditGapBatch {
  operationId: string;
  count: number;
}

interface AuditIdleWaiter {
  resolve(): void;
  reject(reason: unknown): void;
}

function canonicalDatabasePath(databasePath: string): string {
  if (
    databasePath === ":memory:" ||
    databasePath.startsWith("file:") ||
    databasePath.includes("\0") ||
    !isAbsolute(databasePath) ||
    basename(databasePath).length === 0
  ) {
    throw new TypeError(
      "databasePath must be an absolute durable filesystem path",
    );
  }
  return existsSync(databasePath)
    ? realpathSync(databasePath)
    : join(realpathSync(dirname(databasePath)), basename(databasePath));
}

/** Main-thread IPC client. SQLite is loaded only by sqlite-durable-admission-worker. */
export class SqliteDurableAdmissionStore {
  readonly #worker: Worker;
  readonly #registryRevisionFence = new Int32Array(new SharedArrayBuffer(8));
  readonly #testCommitBarrier = new Int32Array(new SharedArrayBuffer(8));
  readonly #pending = new Map<number, Pending>();
  readonly #auditQueue: QueuedAudit[] = [];
  readonly #auditIdleWaiters: AuditIdleWaiter[] = [];
  readonly #auditQueueCapacity: number;
  #nextRequestId = 1;
  #closed = false;
  #closing = false;
  #auditScheduled = false;
  #auditInFlight = false;
  #droppedAuditCount = 0;
  #retryingAuditGap: AuditGapBatch | undefined;
  #auditGapStorageFailures = 0;
  #auditFailure?: Error;
  #closePromise?: Promise<void>;
  #terminalError?: Error;
  readonly #timeoutMs: number;

  constructor(options: DurableAdmissionStoreOptions) {
    validateOptions(options);
    const resolvedOptions = {
      ...options,
      databasePath: canonicalDatabasePath(options.databasePath),
    };
    this.#timeoutMs = options.requestTimeoutMs ?? 2_000;
    this.#auditQueueCapacity = options.auditCapacity ?? 10_000;
    const siblingWorker = new URL(
      "./sqlite-durable-admission-worker.js",
      import.meta.url,
    );
    // Vitest executes TypeScript sources but Node workers do not receive Vite transforms.
    // The canonical test command builds first; use that emitted worker when source has no JS sibling.
    const workerUrl = existsSync(siblingWorker)
      ? siblingWorker
      : new URL(
          "../../dist/src/storage/sqlite-durable-admission-worker.js",
          import.meta.url,
        );
    this.#worker = new Worker(workerUrl, {
      workerData: {
        ...resolvedOptions,
        registryRevisionFence: this.#registryRevisionFence.buffer,
        testCommitBarrier: this.#testCommitBarrier.buffer,
      },
    });
    this.#worker.on("message", (reply: WorkerReply) => {
      this.#onReply(reply);
    });
    this.#worker.on("error", (error: Error) => {
      this.#terminalError = error;
      this.#failAll(error);
    });
    this.#worker.on("exit", (code: number) => {
      if (this.#closed && this.#pending.size === 0) return;
      const error = new DurableAdmissionStoreError({
        code: "storage_unavailable",
        message: `storage worker exited (${String(code)})`,
      });
      this.#terminalError ??= error;
      this.#failAll(this.#terminalError);
    });
  }

  static async open(
    options: DurableAdmissionStoreOptions,
  ): Promise<SqliteDurableAdmissionStore> {
    const store = new SqliteDurableAdmissionStore(options);
    try {
      await store.ready();
      return store;
    } catch (error) {
      store.#closed = true;
      await store.#worker.terminate();
      throw error;
    }
  }

  async ready(): Promise<void> {
    await this.#request("ready", {}, false, Math.max(this.#timeoutMs, 2_000));
  }
  async lookupReceipt(
    request: LookupStoredReceiptRequest,
  ): Promise<StoredTask | undefined> {
    return this.#request("lookupReceipt", request) as Promise<
      StoredTask | undefined
    >;
  }
  async installRegistryRevision(revision: number): Promise<void> {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new TypeError("Registry revision must be a positive safe integer");
    }
    await this.#acquireRegistryCommitFence();
    try {
      const current = Atomics.load(this.#registryRevisionFence, 0);
      if (revision < current) {
        throw new Error("Registry revision cannot move backwards");
      }
      Atomics.store(this.#registryRevisionFence, 0, revision);
    } finally {
      Atomics.store(this.#registryRevisionFence, 1, 0);
      Atomics.notify(this.#registryRevisionFence, 1);
    }
    await this.#request("installRegistryRevision", { revision });
  }
  async submit(
    request: SubmitStoredTaskRequest,
  ): Promise<StoredMutationResult> {
    return this.#request("submit", request) as Promise<StoredMutationResult>;
  }
  async cancel(
    request: CancelStoredTaskRequest,
  ): Promise<StoredMutationResult> {
    return this.#request("cancel", request) as Promise<StoredMutationResult>;
  }
  async claimAndPrepare(
    request: ClaimAndPrepareExecutionRequest,
  ): Promise<StoredExecution> {
    return this.#request(
      "claimAndPrepare",
      request,
    ) as Promise<StoredExecution>;
  }
  async recoverExecutions(): Promise<void> {
    await this.#request("recoverExecutions", {});
  }
  async quarantineExecution(request: {
    accessScopeId: string;
    allowedAgentIds: readonly string[];
    taskId: string;
  }): Promise<StoredExecution> {
    return this.#request(
      "quarantineExecution",
      request,
    ) as Promise<StoredExecution>;
  }
  async getExecution(request: {
    accessScopeId: string;
    allowedAgentIds: readonly string[];
    taskId: string;
  }): Promise<StoredExecution | undefined> {
    return this.#request("getExecution", request) as Promise<
      StoredExecution | undefined
    >;
  }
  async transitionTasks(request: TransitionStoredTasksRequest): Promise<void> {
    await this.#request("transitionTasks", request);
  }
  async recordAudit(record: SanitizedAuditRecord): Promise<void> {
    if (
      this.#closed ||
      this.#closing ||
      this.#terminalError !== undefined ||
      this.#auditFailure !== undefined
    ) {
      throw new DurableAdmissionStoreError({
        code: "storage_unavailable",
        message: "storage is not accepting audit records",
      });
    }
    if (this.#auditQueue.length >= this.#auditQueueCapacity) {
      const dropped = this.#auditQueue.shift();
      dropped?.reject(
        new DurableAdmissionStoreError({
          code: "observation_unavailable",
          message: "audit queue overflowed before persistence",
        }),
      );
      this.#droppedAuditCount = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.#droppedAuditCount + 1,
      );
    }
    await new Promise<void>((resolve, reject) => {
      this.#auditQueue.push({ record, resolve, reject });
      this.#scheduleAudit();
    });
  }
  async flushAudit(): Promise<void> {
    await this.#waitForAuditIdle();
  }
  async getTask(request: {
    accessScopeId: string;
    allowedAgentIds: readonly string[];
    taskId: string;
  }): Promise<StoredTask | undefined> {
    return this.#request("get", request) as Promise<StoredTask | undefined>;
  }
  async listTasks(request: {
    accessScopeId: string;
    allowedAgentIds: readonly string[];
    agentId?: string;
    state?: StoredTaskState;
    afterQueueOrder?: number;
    limit: number;
  }): Promise<{ tasks: StoredTask[]; lastQueueOrder?: number }> {
    return this.#request("list", request) as Promise<{
      tasks: StoredTask[];
      lastQueueOrder?: number;
    }>;
  }
  async getEvents(request: {
    accessScopeId: string;
    allowedAgentIds: readonly string[];
    taskId?: string;
    afterCursor?: number;
    limit: number;
  }): Promise<{ events: StoredEvent[]; lastCursor?: number }> {
    return this.#request("events", request) as Promise<{
      events: StoredEvent[];
      lastCursor?: number;
    }>;
  }
  /** Test-only probes stay in the worker and cannot create a process or execution seam. */
  async probe(
    probe:
      | "block"
      | "armCommitBarrier"
      | "applyExecutionControlRollback"
      | "corruptReservedControlSummary"
      | "exhaustRestartEventReserve"
      | "exitClean"
      | "failNextAuditGap"
      | "failAuditGapPermanently"
      | "failNextCommit"
      | "largeRead"
      | "makeSchemaIncomplete"
      | "inspectPhysicalCapacity"
      | "inspectProductAudit"
      | "inspectSchemaVersions"
      | "inspectDurability"
      | "releaseCommitBarrier"
      | "setFutureSchemaVersion"
      | "truncatePhysicalControlReserve"
      | "underfundTaskEventLedger"
      | "underfundTaskReservationLedger"
      | "waitForCommitBarrier"
      | "waitForRegistryRevision"
      | "zeroTaskReservationLedger",
    milliseconds = 0,
  ): Promise<unknown> {
    if (probe === "armCommitBarrier") {
      Atomics.store(this.#testCommitBarrier, 1, 0);
      Atomics.store(this.#testCommitBarrier, 0, 1);
      return Promise.resolve();
    }
    if (probe === "releaseCommitBarrier") {
      Atomics.store(this.#testCommitBarrier, 0, 0);
      Atomics.notify(this.#testCommitBarrier, 0);
      return Promise.resolve();
    }
    if (probe === "waitForCommitBarrier") {
      return this.#waitForSharedValue(this.#testCommitBarrier, 1, 1);
    }
    if (probe === "waitForRegistryRevision") {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
        throw new TypeError("expected Registry revision must be positive");
      }
      return this.#waitForSharedValue(
        this.#registryRevisionFence,
        0,
        milliseconds,
      );
    }
    return this.#request("probe", { probe, milliseconds });
  }
  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      await this.#waitForAuditIdle().catch(() => undefined);
      this.#closed = true;
      if (this.#terminalError !== undefined) {
        await this.#worker.terminate();
        return;
      }
      await this.#request("close", {}, true, null);
    })();
    return this.#closePromise;
  }

  async #acquireRegistryCommitFence(): Promise<void> {
    while (
      Atomics.compareExchange(this.#registryRevisionFence, 1, 0, 1) !== 0
    ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  async #waitForSharedValue(
    values: Int32Array,
    index: number,
    expected: number,
  ): Promise<void> {
    const deadline = Date.now() + Math.max(this.#timeoutMs, 2_000);
    while (Atomics.load(values, index) !== expected) {
      if (Date.now() >= deadline) {
        throw new DurableAdmissionStoreError({
          code: "observation_unavailable",
          message: "test synchronization timed out",
        });
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  #scheduleAudit(): void {
    if (
      this.#auditScheduled ||
      this.#auditInFlight ||
      this.#auditFailure !== undefined ||
      (this.#auditQueue.length === 0 &&
        this.#droppedAuditCount === 0 &&
        this.#retryingAuditGap === undefined)
    ) {
      return;
    }
    this.#auditScheduled = true;
    setImmediate(() => {
      this.#auditScheduled = false;
      let gap = this.#retryingAuditGap;
      if (gap === undefined && this.#droppedAuditCount > 0) {
        gap = {
          operationId: randomUUID(),
          count: this.#droppedAuditCount,
        };
        this.#droppedAuditCount = 0;
        this.#retryingAuditGap = gap;
      }
      const queued = gap === undefined ? this.#auditQueue.shift() : undefined;
      if (queued === undefined && gap === undefined) {
        this.#resolveAuditIdle();
        return;
      }
      this.#auditInFlight = true;
      void this.#request(
        gap === undefined ? "recordAudit" : "recordAuditGap",
        gap ?? queued?.record,
        true,
      )
        .then(
          () => {
            if (
              gap !== undefined &&
              this.#retryingAuditGap?.operationId === gap.operationId
            ) {
              this.#retryingAuditGap = undefined;
              this.#auditGapStorageFailures = 0;
            }
            queued?.resolve();
          },
          (error: unknown) => {
            if (
              gap !== undefined &&
              !(
                error instanceof DurableAdmissionStoreError &&
                error.code === "observation_unavailable"
              )
            ) {
              this.#auditGapStorageFailures += 1;
              if (this.#auditGapStorageFailures >= 2) {
                this.#failAudit(
                  error instanceof Error
                    ? error
                    : new Error("product audit gap persistence failed"),
                );
              }
            }
            queued?.reject(error);
          },
        )
        .finally(() => {
          this.#auditInFlight = false;
          if (this.#auditFailure !== undefined) return;
          if (
            this.#auditQueue.length > 0 ||
            this.#droppedAuditCount > 0 ||
            this.#retryingAuditGap !== undefined
          )
            this.#scheduleAudit();
          else this.#resolveAuditIdle();
        });
    });
  }

  #waitForAuditIdle(): Promise<void> {
    if (this.#auditFailure !== undefined) {
      return Promise.reject(this.#auditFailure);
    }
    if (
      !this.#auditInFlight &&
      this.#auditQueue.length === 0 &&
      this.#droppedAuditCount === 0 &&
      this.#retryingAuditGap === undefined
    ) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) =>
      this.#auditIdleWaiters.push({ resolve, reject }),
    );
  }

  #resolveAuditIdle(): void {
    if (this.#auditFailure !== undefined) {
      for (const waiter of this.#auditIdleWaiters.splice(0)) {
        waiter.reject(this.#auditFailure);
      }
      return;
    }
    if (
      this.#auditInFlight ||
      this.#auditQueue.length > 0 ||
      this.#droppedAuditCount > 0 ||
      this.#retryingAuditGap !== undefined
    )
      return;
    for (const waiter of this.#auditIdleWaiters.splice(0)) waiter.resolve();
  }

  #failAudit(error: Error): void {
    this.#auditFailure ??= error;
    for (const audit of this.#auditQueue.splice(0)) audit.reject(error);
    this.#droppedAuditCount = 0;
    this.#retryingAuditGap = undefined;
    this.#resolveAuditIdle();
  }

  #request(
    command: string,
    payload: unknown,
    allowClosed = false,
    timeoutMs: number | null = this.#timeoutMs,
  ): Promise<unknown> {
    if (this.#terminalError !== undefined) {
      return Promise.reject(this.#terminalError);
    }
    if ((this.#closed || this.#closing) && !allowClosed)
      return Promise.reject(
        new DurableAdmissionStoreError({
          code: "storage_unavailable",
          message: "storage is closed",
        }),
      );
    const requestId = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      const pending: Pending = { resolve, reject };
      if (timeoutMs !== null) {
        pending.timer = setTimeout(() => {
          this.#pending.delete(requestId);
          reject(
            new DurableAdmissionStoreError({
              code: "observation_unavailable",
              message: "storage request timed out",
            }),
          );
        }, timeoutMs);
      }
      this.#pending.set(requestId, pending);
      this.#worker.postMessage({ requestId, command, payload });
    });
  }
  #onReply(reply: WorkerReply): void {
    const pending = this.#pending.get(reply.requestId);
    if (!pending) return; // bounded client: discard replies after timeout.
    this.#pending.delete(reply.requestId);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    if (reply.failure) {
      pending.reject(new DurableAdmissionStoreError(reply.failure));
    } else pending.resolve(reply.result);
  }
  #failAll(error: Error): void {
    for (const [, pending] of this.#pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#failAudit(error);
  }
}

interface WorkerReply {
  requestId: number;
  result?: unknown;
  failure?: StoreFailure;
}
