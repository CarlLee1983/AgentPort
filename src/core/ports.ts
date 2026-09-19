import type {
  CancelStoredTaskRequest,
  LookupStoredReceiptRequest,
  StoredEvent,
  StoredExecution,
  StoredMutationResult,
  StoredTask,
  StoredTaskState,
  SubmitStoredTaskRequest,
  TransitionStoredTasksRequest,
  ClaimAndPrepareExecutionRequest,
  CommitExecutionObservationRequest,
  StoredObservationCommit,
  StoredQuestion,
  StoredStartCommit,
  StoredTaskProjection,
  StoredTerminalCommit,
  TerminalStopEvidence,
  ExpireRetainedDataRequest,
  RetentionRunSummary,
  ResumeStoredContextRequest,
  AcknowledgeStoredInterruptionRequest,
} from "../storage/sqlite-durable-admission-store.js";
import type { ExecutionReference, RuntimeQuestionIdentity } from "./types.js";

export interface DurableAdmissionStore {
  installRegistryRevision(
    revision: number,
    persist?: boolean,
    fingerprint?: string,
  ): Promise<void>;
  lookupReceipt(
    request: LookupStoredReceiptRequest,
  ): Promise<StoredTask | undefined>;
  submit(request: SubmitStoredTaskRequest): Promise<StoredMutationResult>;
  cancel(request: CancelStoredTaskRequest): Promise<StoredMutationResult>;
  edit(request: {
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
  }): Promise<StoredMutationResult>;
  resumeContext(
    request: ResumeStoredContextRequest,
  ): Promise<StoredMutationResult>;
  acknowledgeInterruption(
    request: AcknowledgeStoredInterruptionRequest,
  ): Promise<StoredMutationResult>;
  confirmRecoveryStopped(request: {
    evidence: TerminalStopEvidence;
    now: string;
  }): Promise<void>;
  replyToQuestion(request: {
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
  }): Promise<{
    execution: StoredExecution;
    question: StoredQuestion;
    task: StoredTask;
    replayed: boolean;
  }>;
  /** Trusted worker ingress; the core supplies the expiry, never the worker. */
  persistQuestionObservation(
    request: RuntimeQuestionIdentity & {
      reference: StoredQuestion["reference"];
      ordinal: number;
      toolActivity: "none";
      activeElapsedMs: number;
      schema: unknown;
      expiresAt: string;
      now: string;
    },
  ): Promise<StoredQuestion>;
  /** Internal delivery lookup; it has no Caller authorization surface. */
  getQuestionForDelivery(
    request: RuntimeQuestionIdentity & {
      reference: StoredQuestion["reference"];
      now: string;
    },
  ): Promise<StoredQuestion | undefined>;
  /** Trusted worker acknowledgement; it is the only input-wait release. */
  acknowledgeQuestionDelivery(
    request: RuntimeQuestionIdentity & {
      reference: StoredQuestion["reference"];
      now: string;
    },
  ): Promise<{ question: StoredQuestion; task: StoredTask }>;
  markQuestionDeliveryUnknown(
    request: RuntimeQuestionIdentity & {
      reference: StoredQuestion["reference"];
      now: string;
    },
  ): Promise<void>;
  transitionTasks(request: TransitionStoredTasksRequest): Promise<void>;
  claimAndPrepare(
    request: ClaimAndPrepareExecutionRequest,
  ): Promise<StoredExecution>;
  getTaskForDispatch(taskId: string): Promise<StoredTask | undefined>;
  markExecutionRunning(request: {
    reference: ExecutionReference;
    now?: string;
  }): Promise<StoredStartCommit>;
  quarantineExecutionForDispatch(request: {
    reference: ExecutionReference;
  }): Promise<StoredExecution>;
  interruptExecution(request: {
    reference: ExecutionReference;
    activeElapsedMs: number;
  }): Promise<StoredExecution>;
  commitExecutionObservation(
    request: CommitExecutionObservationRequest,
  ): Promise<StoredObservationCommit>;
  /** Internal Reference-bound worker ingress; it has no Caller authorization surface. */
  commitRuntimeObservation(request: {
    taskId: string;
    observation: unknown;
    now: string;
  }): Promise<StoredObservationCommit>;
  commitTerminal(request: {
    evidence: TerminalStopEvidence;
    activeElapsedMs?: number;
    now?: string;
  }): Promise<StoredTerminalCommit>;
  recoverExecutions(request?: {
    reason?: "daemon_restart" | "daemon_shutdown";
  }): Promise<StoredExecution[]>;
  quarantineExecution(request: {
    accessScopeId: string;
    allowedAgentIds: readonly string[];
    taskId: string;
  }): Promise<StoredExecution>;
  getExecution(request: {
    accessScopeId: string;
    allowedAgentIds: readonly string[];
    taskId: string;
  }): Promise<StoredExecution | undefined>;
  getTask(request: {
    accessScopeId: string;
    allowedAgentIds: readonly string[];
    taskId: string;
  }): Promise<StoredTask | undefined>;
  getTaskProjection(request: {
    accessScopeId: string;
    allowedAgentIds: readonly string[];
    taskId: string;
  }): Promise<StoredTaskProjection | undefined>;
  listTasks(request: {
    accessScopeId: string;
    allowedAgentIds: readonly string[];
    agentId?: string;
    state?: StoredTaskState;
    afterQueueOrder?: number;
    retentionSequence?: number;
    limit: number;
  }): Promise<{
    tasks: StoredTask[];
    lastQueueOrder?: number;
    retentionSequence: number;
  }>;
  getEvents(request: {
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
  }>;
  expireRetainedData(
    request: ExpireRetainedDataRequest,
  ): Promise<RetentionRunSummary>;
}
