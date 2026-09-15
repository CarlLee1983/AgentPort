import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Worker } from "node:worker_threads";
import type { StorageIncidentReporter } from "../core/storage-incident-safety.js";
import type {
  BindingSnapshotRecord,
  ExecutionReference,
  RuntimeQuestionIdentity,
} from "../core/types.js";

export type StoredTaskState =
  | "queued"
  | "paused"
  | "awaiting_input"
  | "starting"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "canceled"
  | "recovering"
  | "interrupted";

export interface StoredTask {
  taskId: string;
  contextId: string;
  contextRevision: number;
  accessScopeId: string;
  agentId: string;
  state: StoredTaskState;
  revision: number;
  queueOrder: number;
  /** Immutable edge to the preceding accepted Task in this Context. */
  predecessorTaskId: string | null;
  blocker: {
    predecessorTaskId: string;
    state: "failed" | "canceled" | "interrupted" | "recovering";
  } | null;
  continuation: {
    mode: "preserve" | "fresh_session";
    nativeContinuity: "preserved" | "abandoned";
  } | null;
  instruction: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  reason?: string | null;
  executionLimitSeconds?: number | null;
  inputWaitSeconds?: number | null;
  /** Derived only by the immutable terminal transaction; never worker supplied. */
  result: {
    kind: "completed" | "failed" | "canceled";
    summary: string | null;
  } | null;
}

export interface StoredExecution {
  executionId: string;
  taskId: string;
  generation: string;
  daemonEpoch: string;
  launchProfileId: string;
  workspaceId: string;
  state:
    | "prepared"
    | "starting"
    | "running"
    | "stopping"
    | "recovering"
    | "interrupted";
  workspaceClaim: "held" | "quarantined" | "released";
  progress: {
    ordinal: number;
    summary: string;
    observedAt: string;
  } | null;
  lastObservationOrdinal: number;
  candidateAvailable: boolean;
  finalOrdinal: number | null;
  stopReason: "completion" | "cancellation" | "interruption" | null;
  recoveryReason: string | null;
  accumulatedExecutionMs: number;
  accountingPhase: "active" | "pure_wait" | "stopped";
  accountingPhaseStartedAt: string | null;
  /** Internal launch material returned only by the atomic dispatch claim. */
  launchContinuation?:
    | {
        kind: "resume";
        sourceReference: {
          executionId: string;
          generation: string;
          daemonEpoch: string;
          launchProfileId: string;
          workspaceIdentity: string;
        };
        sessionReference: string;
        protectedSessionToken: string;
      }
    | { kind: "fresh_session"; contextSummary: string };
  revision: number;
}

export type StoredStartCommit =
  | { kind: "running"; execution: StoredExecution }
  | { kind: "stop_required"; execution: StoredExecution };

export interface TerminalStopEvidence {
  platform: string;
  reference: {
    executionId: string;
    generation: string;
    daemonEpoch: string;
    launchProfileId: string;
    workspaceIdentity: string;
  };
  executionUnitId: string;
  generationSealedAt: string;
  unitEmptyObservedAt: string;
}

export interface StoredTerminalCommit {
  task: StoredTask;
  execution: StoredExecution;
  replayed: boolean;
}

export interface CommitExecutionObservationRequest {
  accessScopeId: string;
  allowedAgentIds: readonly string[];
  expectedRegistryRevision: number;
  taskId: string;
  observation: unknown;
  now: string;
}

export interface StoredObservationCommit {
  execution: StoredExecution;
  replayed: boolean;
}

/**
 * A bounded, caller-visible representation of one native AskUserQuestion
 * exchange. The worker validates both `schema` and `answer` before either is
 * persisted; callers never select its execution reference.
 */
export interface StoredQuestion {
  questionId: string;
  /** Null only for a pre-v9 row that cannot be delivered or acknowledged. */
  toolUseId: string | null;
  /** Null only for a pre-v9 row that cannot be delivered or acknowledged. */
  requestId: string | null;
  taskId: string;
  executionId: string;
  reference: {
    executionId: string;
    generation: string;
    daemonEpoch: string;
    launchProfileId: string;
    workspaceIdentity: string;
  };
  schema: readonly {
    question: string;
    header: string;
    options: readonly {
      label: string;
      description: string;
      preview?: string;
    }[];
    multiSelect: boolean;
  }[];
  state: "pending" | "accepted" | "closed";
  delivery: "pending" | "acknowledged" | "unknown";
  answer: Record<string, string> | null;
  acceptedAt: string | null;
  expiresAt: string;
  deliveryAcknowledgedAt: string | null;
  deliveryUnknownAt: string | null;
  inputExpiryClosedAt: string | null;
  closedAt: string | null;
  closureReason: "expired" | "canceled" | "recovery" | "terminal" | null;
  toolActivityStatus: "idle" | "unknown";
  toolActivityObservedAt: string | null;
  createdAt: string;
}

export interface StoredTaskProjection {
  task: StoredTask;
  execution: StoredExecution | null;
  question: StoredQuestion | null;
}

export interface ExpireRetainedDataRequest {
  /** Trusted maintenance time, never Caller supplied. */
  asOf: string;
  /** Maximum number of Tasks processed by one short transaction. */
  batchLimit?: number;
}

export interface RetentionRunSummary {
  contextsExpired: number;
  tasksExpired: number;
  receiptsTombstoned: number;
  eventsExpired: number;
  asOf: string;
  cutoff: string;
}

export interface PersistStoredQuestionRequest extends RuntimeQuestionIdentity {
  reference: StoredQuestion["reference"];
  ordinal: number;
  toolActivity: "none";
  activeElapsedMs: number;
  schema: unknown;
  expiresAt: string;
  now: string;
}

export interface ReplyToStoredQuestionRequest {
  accessScopeId: string;
  allowedAgentIds: readonly string[];
  expectedRegistryRevision: number;
  operationId: string;
  fingerprint: string;
  principalId: string;
  taskId: string;
  questionId: string;
  answer: unknown;
  now: string;
}

export interface AcknowledgeStoredQuestionRequest extends RuntimeQuestionIdentity {
  reference: StoredQuestion["reference"];
  now: string;
}

export interface MarkStoredQuestionDeliveryUnknownRequest extends RuntimeQuestionIdentity {
  reference: StoredQuestion["reference"];
  now: string;
}

export interface GetStoredQuestionForDeliveryRequest extends RuntimeQuestionIdentity {
  reference: StoredQuestion["reference"];
  now: string;
}

export interface ClaimAndPrepareExecutionRequest {
  accessScopeId: string;
  allowedAgentIds: readonly string[];
  expectedRegistryRevision: number;
  executionId: string;
  taskId: string;
  generation: string;
  daemonEpoch: string;
  dispatchIntent?: boolean;
  binding: BindingSnapshotRecord;
}

export interface StoredEvent {
  cursor: number;
  taskId: string;
  taskSeq: number;
  agentId: string;
  type:
    | "accepted"
    | "edited"
    | "daemon_restart_paused"
    | "cancel_requested"
    | "completed"
    | "failed"
    | "canceled"
    | "interrupted";
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
    | "result_expired"
    | "cursor_expired"
    | "not_found";
  message: string;
  taskId?: string;
  /** Internal classification; never projected to an MCP Caller. */
  incident?: boolean;
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
  /**
   * Base64url-encoded 256-bit key held outside SQLite. It encrypts raw Claude
   * resumable session identities; the store never returns those identities on
   * caller-facing methods.
   */
  continuationEncryptionKey?: string;
  /** Fail-closed v3-aware rollback mode: query/control only, no new work or observations. */
  recoveryOnly?: boolean;
  auditCapacity?: number;
  activeExecutionCapacity?: number;
  queuePerWorkspace?: number;
  queueGlobal?: number;
  receiptCapacity?: number;
  admissionBytes?: number;
  physicalAdmissionBytes?: number;
  physicalControlReserveBytes?: number;
  taskControlReserveBytes?: number;
  controlReceiptReserve?: number;
  controlEventReserve?: number;
  terminalRetentionDays?: number;
  /** Internal maintenance cadence; never exposed to an MCP Caller. */
  retentionSweepIntervalMs?: number;
  busyTimeoutMs?: number;
  requestTimeoutMs?: number;
}

const positiveIntegerOptions = [
  "auditCapacity",
  "activeExecutionCapacity",
  "queuePerWorkspace",
  "queueGlobal",
  "receiptCapacity",
  "admissionBytes",
  "physicalAdmissionBytes",
  "physicalControlReserveBytes",
  "taskControlReserveBytes",
  "controlReceiptReserve",
  "controlEventReserve",
  "terminalRetentionDays",
  "retentionSweepIntervalMs",
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
  if (
    options.continuationEncryptionKey !== undefined &&
    (!/^[A-Za-z0-9_-]{43}$/u.test(options.continuationEncryptionKey) ||
      Buffer.from(options.continuationEncryptionKey, "base64url").byteLength !==
        32)
  ) {
    throw new TypeError(
      "continuationEncryptionKey must be a 256-bit base64url key",
    );
  }
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
  if (
    options.controlReceiptReserve !== undefined &&
    options.controlReceiptReserve < 2
  ) {
    throw new TypeError(
      "controlReceiptReserve must reserve reply and terminal control receipts",
    );
  }
  if (
    options.terminalRetentionDays !== undefined &&
    options.terminalRetentionDays >
      Math.floor(Number.MAX_SAFE_INTEGER / (24 * 60 * 60 * 1_000))
  ) {
    throw new TypeError("terminalRetentionDays is too large");
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
  if (taskControlReserveBytes < 128 * 1024) {
    throw new TypeError(
      "taskControlReserveBytes must reserve at least 128 KiB for reply control writes",
    );
  }
  if (
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
  /** Existing authorized Context for a follow-up; omitted creates contextId. */
  existingContextId?: string;
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
    | "launchProfileId"
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
  activeElapsedMs?: number;
}

export interface EditStoredTaskRequest {
  accessScopeId: string;
  operationId: string;
  fingerprint: string;
  principalId: string;
  expectedRegistryRevision: number;
  allowedAgentIds: readonly string[];
  taskId: string;
  expectedRevision: number;
  instruction: string;
  now: string;
}

export interface ResumeStoredContextRequest {
  accessScopeId: string;
  operationId: string;
  fingerprint: string;
  principalId: string;
  expectedRegistryRevision: number;
  allowedAgentIds: readonly string[];
  contextId: string;
  expectedRevision: number;
  continuationMode: "preserve" | "fresh_session";
  contextSummary?: string;
  now: string;
}

export interface AcknowledgeStoredInterruptionRequest {
  accessScopeId: string;
  operationId: string;
  fingerprint: string;
  principalId: string;
  expectedRegistryRevision: number;
  allowedAgentIds: readonly string[];
  taskId: string;
  expectedRevision: number;
  now: string;
}

export interface TransitionStoredTasksRequest {
  fromState: StoredTaskState;
  toState: StoredTaskState;
  reason: string;
  eventType: StoredEvent["type"];
}

export interface LookupStoredReceiptRequest {
  accessScopeId: string;
  allowedAgentIds: readonly string[];
  expectedAgentId?: string;
  operationId: string;
  operationType:
    "submit" | "cancel" | "edit" | "resume" | "acknowledge_interruption";
  targetId?: string;
  fingerprint: string;
}

interface Pending {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer?: NodeJS.Timeout;
  incidentOnStorageFailure: boolean;
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

const STORAGE_MUTATION_COMMANDS = new Set([
  "acknowledgeInterruption",
  "acknowledgeQuestionDelivery",
  "cancel",
  "claimAndPrepare",
  "commitExecutionObservation",
  "commitRuntimeObservation",
  "commitTerminal",
  "confirmRecoveryStopped",
  "edit",
  "expireRetainedData",
  "installRegistryRevision",
  "interruptExecution",
  "markExecutionRunning",
  "markQuestionDeliveryUnknown",
  "persistQuestionObservation",
  "quarantineExecution",
  "quarantineExecutionForDispatch",
  "replyToQuestion",
  "resumeContext",
  "submit",
  "transitionTasks",
]);

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
  readonly #retentionSweepIntervalMs: number;
  readonly #retentionEnabled: boolean;
  #retentionTimer: NodeJS.Timeout | undefined;

  constructor(
    options: DurableAdmissionStoreOptions,
    private readonly storageIncident?: StorageIncidentReporter,
  ) {
    validateOptions(options);
    const resolvedOptions = {
      ...options,
      databasePath: canonicalDatabasePath(options.databasePath),
    };
    this.#timeoutMs = options.requestTimeoutMs ?? 2_000;
    this.#auditQueueCapacity = options.auditCapacity ?? 10_000;
    this.#retentionSweepIntervalMs =
      options.retentionSweepIntervalMs ?? 60 * 60 * 1_000;
    this.#retentionEnabled = options.recoveryOnly !== true;
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
      this.storageIncident?.report();
      this.#terminalError = error;
      this.#failAll(error);
    });
    this.#worker.on("exit", (code: number) => {
      if (this.#closed && this.#pending.size === 0) return;
      const error = new DurableAdmissionStoreError({
        code: "storage_unavailable",
        message: `storage worker exited (${String(code)})`,
      });
      this.storageIncident?.report();
      this.#terminalError ??= error;
      this.#failAll(this.#terminalError);
    });
  }

  static async open(
    options: DurableAdmissionStoreOptions,
    storageIncident?: StorageIncidentReporter,
  ): Promise<SqliteDurableAdmissionStore> {
    const store = new SqliteDurableAdmissionStore(options, storageIncident);
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
    this.#scheduleRetention();
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
  async edit(request: EditStoredTaskRequest): Promise<StoredMutationResult> {
    return this.#request("edit", request) as Promise<StoredMutationResult>;
  }
  async resumeContext(
    request: ResumeStoredContextRequest,
  ): Promise<StoredMutationResult> {
    return this.#request(
      "resumeContext",
      request,
    ) as Promise<StoredMutationResult>;
  }
  async confirmRecoveryStopped(request: {
    evidence: TerminalStopEvidence;
    now: string;
  }): Promise<void> {
    await this.#request("confirmRecoveryStopped", request);
  }
  async acknowledgeInterruption(
    request: AcknowledgeStoredInterruptionRequest,
  ): Promise<StoredMutationResult> {
    return this.#request(
      "acknowledgeInterruption",
      request,
    ) as Promise<StoredMutationResult>;
  }
  /** Trusted worker ingress: persist before any Question becomes observable. */
  async persistQuestionObservation(
    request: PersistStoredQuestionRequest,
  ): Promise<StoredQuestion> {
    return this.#request(
      "persistQuestionObservation",
      request,
    ) as Promise<StoredQuestion>;
  }
  /** Caller mutation: the first schema-valid answer becomes delivery-pending. */
  async replyToQuestion(request: ReplyToStoredQuestionRequest): Promise<{
    execution: StoredExecution;
    question: StoredQuestion;
    task: StoredTask;
    replayed: boolean;
  }> {
    return this.#request("replyToQuestion", request) as Promise<{
      execution: StoredExecution;
      question: StoredQuestion;
      task: StoredTask;
      replayed: boolean;
    }>;
  }
  /** Internal worker delivery lookup; no Caller controls this reference. */
  async getQuestionForDelivery(
    request: GetStoredQuestionForDeliveryRequest,
  ): Promise<StoredQuestion | undefined> {
    return this.#request("getQuestionForDelivery", request) as Promise<
      StoredQuestion | undefined
    >;
  }
  /** Trusted worker acknowledgement; no caller controlled delivery transition. */
  async acknowledgeQuestionDelivery(
    request: AcknowledgeStoredQuestionRequest,
  ): Promise<{ question: StoredQuestion; task: StoredTask }> {
    return this.#request("acknowledgeQuestionDelivery", request) as Promise<{
      question: StoredQuestion;
      task: StoredTask;
    }>;
  }
  /** Worker loss makes a pending accepted delivery non-redeliverable. */
  async markQuestionDeliveryUnknown(
    request: MarkStoredQuestionDeliveryUnknownRequest,
  ): Promise<void> {
    await this.#request("markQuestionDeliveryUnknown", request);
  }
  async claimAndPrepare(
    request: ClaimAndPrepareExecutionRequest,
  ): Promise<StoredExecution> {
    return this.#request(
      "claimAndPrepare",
      request,
    ) as Promise<StoredExecution>;
  }
  async getTaskForDispatch(taskId: string): Promise<StoredTask | undefined> {
    return this.#request("getTaskForDispatch", { taskId }) as Promise<
      StoredTask | undefined
    >;
  }
  /**
   * Returns at most one currently dispatchable Context head per unclaimed
   * Workspace, ordered by the durable per-workspace FIFO key.
   */
  async listEligibleContextHeads(request: {
    accessScopeId: string;
    allowedAgentIds: readonly string[];
    limit: number;
  }): Promise<StoredTask[]> {
    return this.#request("listEligibleContextHeads", request) as Promise<
      StoredTask[]
    >;
  }
  /** Internal scheduler seam: one eligible FIFO Context head per Workspace. */
  async getEligibleTasksForDispatch(request: {
    accessScopeId: string;
    allowedAgentIds: readonly string[];
    limit: number;
  }): Promise<StoredTask[]> {
    return this.#request("getEligibleTasksForDispatch", request) as Promise<
      StoredTask[]
    >;
  }
  async markExecutionRunning(request: {
    reference: {
      executionId: string;
      generation: string;
      daemonEpoch: string;
      launchProfileId: string;
      workspaceIdentity: string;
    };
    now?: string;
  }): Promise<StoredStartCommit> {
    return this.#request(
      "markExecutionRunning",
      request,
    ) as Promise<StoredStartCommit>;
  }
  async quarantineExecutionForDispatch(request: {
    reference: {
      executionId: string;
      generation: string;
      daemonEpoch: string;
      launchProfileId: string;
      workspaceIdentity: string;
    };
  }): Promise<StoredExecution> {
    return this.#request(
      "quarantineExecutionForDispatch",
      request,
    ) as Promise<StoredExecution>;
  }
  async interruptExecution(request: {
    reference: ExecutionReference;
    activeElapsedMs: number;
  }): Promise<StoredExecution> {
    return this.#request(
      "interruptExecution",
      request,
    ) as Promise<StoredExecution>;
  }
  async commitExecutionObservation(
    request: CommitExecutionObservationRequest,
  ): Promise<StoredObservationCommit> {
    return this.#request(
      "commitExecutionObservation",
      request,
    ) as Promise<StoredObservationCommit>;
  }
  async commitRuntimeObservation(request: {
    taskId: string;
    observation: unknown;
    now: string;
  }): Promise<StoredObservationCommit> {
    return this.#request(
      "commitRuntimeObservation",
      request,
    ) as Promise<StoredObservationCommit>;
  }
  async commitTerminal(request: {
    evidence: TerminalStopEvidence;
    activeElapsedMs?: number;
    /** Trusted terminal-commit clock for deterministic maintenance tests. */
    now?: string;
  }): Promise<StoredTerminalCommit> {
    return this.#request(
      "commitTerminal",
      request,
    ) as Promise<StoredTerminalCommit>;
  }
  async recoverExecutions(): Promise<StoredExecution[]> {
    return this.#request("recoverExecutions", {}) as Promise<StoredExecution[]>;
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
  async getTaskProjection(request: {
    accessScopeId: string;
    allowedAgentIds: readonly string[];
    taskId: string;
  }): Promise<StoredTaskProjection | undefined> {
    return this.#request("getTaskProjection", request) as Promise<
      StoredTaskProjection | undefined
    >;
  }
  async listTasks(request: {
    accessScopeId: string;
    allowedAgentIds: readonly string[];
    agentId?: string;
    state?: StoredTaskState;
    afterQueueOrder?: number;
    limit: number;
    retentionSequence?: number;
  }): Promise<{
    tasks: StoredTask[];
    lastQueueOrder?: number;
    retentionSequence: number;
  }> {
    return this.#request("list", request) as Promise<{
      tasks: StoredTask[];
      lastQueueOrder?: number;
      retentionSequence: number;
    }>;
  }
  async getEvents(request: {
    accessScopeId: string;
    allowedAgentIds: readonly string[];
    taskId?: string;
    afterCursor?: number;
    retentionSequence?: number;
    limit: number;
  }): Promise<{
    events: StoredEvent[];
    lastCursor?: number;
    retentionSequence: number;
  }> {
    return this.#request("events", request) as Promise<{
      events: StoredEvent[];
      lastCursor?: number;
      retentionSequence: number;
    }>;
  }
  async expireRetainedData(
    request: ExpireRetainedDataRequest,
  ): Promise<RetentionRunSummary> {
    const parsed = Date.parse(request.asOf);
    if (
      !Number.isFinite(parsed) ||
      new Date(parsed).toISOString() !== request.asOf ||
      (request.batchLimit !== undefined &&
        (!Number.isSafeInteger(request.batchLimit) ||
          request.batchLimit < 1 ||
          request.batchLimit > 100))
    ) {
      throw new TypeError("retention request is invalid");
    }
    return this.#request(
      "expireRetainedData",
      request,
    ) as Promise<RetentionRunSummary>;
  }
  /** Test-only probes stay in the worker and cannot create a process or execution seam. */
  async probe(
    probe:
      | "block"
      | "armCommitBarrier"
      | "corruptReservedControlSummary"
      | "exhaustRestartEventReserve"
      | "exitClean"
      | "failNextAuditGap"
      | "failNextReadDiagnostic"
      | "failAuditGapPermanently"
      | "failNextCommit"
      | "failNextStorageBusy"
      | "failNextStorageFull"
      | "failNextStorageIo"
      | "largeRead"
      | "makeSchemaIncomplete"
      | "inspectPhysicalCapacity"
      | "inspectProductAudit"
      | "inspectProtectedSessionTokens"
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
    if (this.#retentionTimer !== undefined) {
      clearTimeout(this.#retentionTimer);
      this.#retentionTimer = undefined;
    }
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

  #scheduleRetention(delayMs = this.#retentionSweepIntervalMs): void {
    if (
      !this.#retentionEnabled ||
      this.#closed ||
      this.#closing ||
      this.#retentionTimer !== undefined
    ) {
      return;
    }
    this.#retentionTimer = setTimeout(() => {
      this.#retentionTimer = undefined;
      void this.#runRetentionSweep();
    }, delayMs);
    this.#retentionTimer.unref();
  }

  async #runRetentionSweep(): Promise<void> {
    if (this.#closed || this.#closing) return;
    try {
      const result = await this.expireRetainedData({
        asOf: new Date().toISOString(),
        batchLimit: 100,
      });
      this.#scheduleRetention(
        result.tasksExpired === 100 ? 0 : this.#retentionSweepIntervalMs,
      );
    } catch {
      this.#scheduleRetention();
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
    const incidentOnStorageFailure = STORAGE_MUTATION_COMMANDS.has(command);
    if (
      incidentOnStorageFailure &&
      this.storageIncident?.isLatched() === true
    ) {
      return Promise.reject(
        new DurableAdmissionStoreError({
          code: "storage_unavailable",
          message: "storage incident requires restart recovery",
        }),
      );
    }
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
      const pending: Pending = {
        resolve,
        reject,
        incidentOnStorageFailure,
      };
      if (timeoutMs !== null) {
        pending.timer = setTimeout(() => {
          this.#pending.delete(requestId);
          if (pending.incidentOnStorageFailure) this.storageIncident?.report();
          reject(
            new DurableAdmissionStoreError({
              code: pending.incidentOnStorageFailure
                ? "storage_unavailable"
                : "observation_unavailable",
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
      if (
        reply.failure.incident === true ||
        (pending.incidentOnStorageFailure &&
          reply.failure.code === "storage_unavailable")
      ) {
        this.storageIncident?.report();
      }
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
