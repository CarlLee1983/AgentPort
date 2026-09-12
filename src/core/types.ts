export const ADMISSION_TASK_STATES = ["queued", "paused", "canceled"] as const;
export const MAX_IDENTIFIER_CHARACTERS = 128;
export const MAX_INSTRUCTION_BYTES = 64 * 1024;
export const MAX_AGENT_DESCRIPTION_BYTES = 8 * 1024;

export type AdmissionTaskState = (typeof ADMISSION_TASK_STATES)[number];

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
  agentId: string;
  instruction: string;
  state: AdmissionTaskState;
  reason: string | null;
  revision: number;
  queueOrder: number;
  executionLimitSeconds: number | null;
  inputWaitSeconds: number | null;
  createdAt: string;
  updatedAt: string;
  observedAt: string;
  observationStatus: "current" | "stale";
}

export type TaskSummary = Omit<
  TaskSnapshot,
  "instruction" | "observedAt" | "observationStatus"
>;

export interface TaskEvent {
  cursor: number;
  taskId: string;
  taskSeq: number;
  agentId: string;
  type: "accepted" | "daemon_restart_paused" | "canceled";
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
}
