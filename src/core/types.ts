export const ADMISSION_TASK_STATES = [
  "queued",
  "paused",
  "starting",
  "running",
  "awaiting_input",
  "stopping",
  "completed",
  "failed",
  "canceled",
  "recovering",
  "interrupted",
] as const;
export const MAX_IDENTIFIER_CHARACTERS = 128;
export const MAX_INSTRUCTION_BYTES = 64 * 1024;
export const MAX_AGENT_DESCRIPTION_BYTES = 8 * 1024;
export const MAX_CONTEXT_SUMMARY_BYTES = 16 * 1024;

export type AdmissionTaskState = (typeof ADMISSION_TASK_STATES)[number];

/** Opaque execution identity used to bind platform-neutral observations. */
export interface ExecutionReference {
  executionId: string;
  generation: string;
  daemonEpoch: string;
  launchProfileId: string;
  workspaceIdentity: string;
}

export interface RuntimeExecutionPolicy {
  executionLimitSeconds: number;
  inputWaitSeconds: number;
}

/** Internal launch material passed only from core storage to the Supervisor. */
export type ProtectedRuntimeLaunchDirective =
  | {
      kind: "resume";
      sourceReference: ExecutionReference;
      sessionReference: string;
      protectedSessionToken: string;
    }
  | { kind: "fresh_session"; contextSummary: string };

/** Native Runtime callback identity retained only on trusted internal seams. */
export interface RuntimeQuestionIdentity {
  questionId: string;
  toolUseId: string;
  requestId: string;
}

export interface CredentialSubject {
  principalId: string;
}

export interface AgentDescriptor {
  agentId: string;
  description: string;
  availability: "available";
  capabilities: readonly ["durable_admission", "queued_cancellation"];
}

export interface TaskSnapshot {
  taskId: string;
  contextId: string;
  contextRevision: number;
  predecessorTaskId: string | null;
  /** The sole removable failed predecessor that currently pauses this Context. */
  blocker: {
    predecessorTaskId: string;
    state: "failed" | "canceled" | "interrupted" | "recovering";
  } | null;
  continuation: {
    mode: "preserve" | "fresh_session";
    nativeContinuity: "preserved" | "abandoned";
  } | null;
  agentId: string;
  instruction: string;
  state: AdmissionTaskState;
  reason: string | null;
  revision: number;
  queueOrder: number;
  executionLimitSeconds: number | null;
  inputWaitSeconds: number | null;
  result: {
    kind: "completed" | "failed" | "canceled";
    summary: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
  observedAt: string;
  observationStatus: "current" | "stale";
  executionLiveness: "alive" | "dead" | "unknown";
  livenessCheckedAt: string | null;
  toolActivityStatus: "active" | "idle" | "unknown";
  toolActivityObservedAt: string | null;
  toolActivityEvidence: {
    toolName: string;
    startedAt: string;
  } | null;
  execution: ExecutionLifecycleSnapshot | null;
  question: TaskQuestionSnapshot | null;
  readiness: {
    status: "blocked";
    reason: "g1_unproven";
  };
}

/** The one durable native clarification currently associated with a Task. */
export interface TaskQuestionSnapshot {
  questionId: string;
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
  createdAt: string;
}

export type TaskSummary = Omit<
  TaskSnapshot,
  | "instruction"
  | "observedAt"
  | "observationStatus"
  | "executionLiveness"
  | "livenessCheckedAt"
  | "toolActivityStatus"
  | "toolActivityObservedAt"
  | "toolActivityEvidence"
  | "execution"
  | "question"
  | "readiness"
>;

export interface TaskEvent {
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

export interface ContextRecord {
  contextId: string;
  accessScopeId: string;
  agentId: string;
  bindingSnapshotId: string;
  revision: number;
  pauseReason: string | null;
  createdAt: string;
}

export interface WorkspaceIdentity {
  canonicalPath: string;
  filesystemIdentity: string;
}

export interface AgentPolicy {
  maximumExecutionLimitSeconds: number;
  maximumInputWaitSeconds: number;
}

export interface BindingSnapshotRecord {
  bindingSnapshotId: string;
  accessScopeId: string;
  agentId: string;
  workspaceIdentity: WorkspaceIdentity;
  configurationRevision: string;
  runtimeDriver: string;
  runtimeVersion: string;
  /** Administrator-selected launcher profile; never supplied by the Caller. */
  launchProfileId: string;
  policy: AgentPolicy;
  createdAt: string;
}

export interface OperationReceiptRecord {
  accessScopeId: string;
  operationId: string;
  operationType: "submit" | "cancel";
  targetId: string | null;
  fingerprint: string;
  actorPrincipalId: string;
  taskId: string;
  createdAt: string;
}

export interface AgentPage {
  agents: AgentDescriptor[];
  nextCursor: string | null;
}

export interface TaskPage {
  tasks: TaskSummary[];
  nextCursor: string | null;
}

export interface EventPage {
  events: TaskEvent[];
  nextCursor: string | null;
}

export interface MutationResult {
  task: TaskSnapshot;
  replayed: boolean;
}

export interface ListAgentsInput {
  cursor?: string;
  limit?: number;
}

export interface SubmitTaskInput {
  operationId: string;
  agentId: string;
  instruction: string;
  /** Append to an authorized Context; omitted creates a new Context. */
  contextId?: string;
  executionLimitSeconds?: number;
  inputWaitSeconds?: number;
}

export interface GetTaskInput {
  taskId: string;
}

export interface ListTasksInput {
  agentId?: string;
  state?: AdmissionTaskState;
  cursor?: string;
  limit?: number;
}

export interface GetEventsInput {
  taskId?: string;
  afterCursor?: string;
  limit?: number;
}

export interface CancelTaskInput {
  operationId: string;
  taskId: string;
}

export interface EditTaskInput {
  operationId: string;
  taskId: string;
  expectedRevision: number;
  instruction: string;
}

export interface ReplyInput {
  operationId: string;
  taskId: string;
  questionId: string;
  answer: Record<string, string>;
}

export interface ResumeContextInput {
  operationId: string;
  contextId: string;
  expectedRevision: number;
  continuationMode: "preserve" | "fresh_session";
  /** Required for fresh_session; an intentionally empty summary is valid. */
  contextSummary?: string;
}

export interface AcknowledgeInterruptionInput {
  operationId: string;
  taskId: string;
  expectedRevision: number;
}

export interface ExecutionLifecycleSnapshot {
  executionId: string;
  taskId: string;
  state:
    | "prepared"
    | "starting"
    | "running"
    | "stopping"
    | "recovering"
    | "interrupted";
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
  quarantined: boolean;
  revision: number;
  observedAt: string;
}

export interface AgentExecutionService {
  listAgents(
    actor: CredentialSubject,
    input: ListAgentsInput,
  ): Promise<AgentPage>;
  submitTask(
    actor: CredentialSubject,
    input: SubmitTaskInput,
  ): Promise<MutationResult>;
  getTask(actor: CredentialSubject, input: GetTaskInput): Promise<TaskSnapshot>;
  listTasks(actor: CredentialSubject, input: ListTasksInput): Promise<TaskPage>;
  getEvents(
    actor: CredentialSubject,
    input: GetEventsInput,
  ): Promise<EventPage>;
  cancelTask(
    actor: CredentialSubject,
    input: CancelTaskInput,
  ): Promise<MutationResult>;
  editTask(
    actor: CredentialSubject,
    input: EditTaskInput,
  ): Promise<MutationResult>;
  reply(actor: CredentialSubject, input: ReplyInput): Promise<MutationResult>;
  resumeContext(
    actor: CredentialSubject,
    input: ResumeContextInput,
  ): Promise<MutationResult>;
  acknowledgeInterruption(
    actor: CredentialSubject,
    input: AcknowledgeInterruptionInput,
  ): Promise<MutationResult>;
}
