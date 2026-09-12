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
} from "../storage/sqlite-durable-admission-store.js";

export interface DurableAdmissionStore {
  installRegistryRevision(revision: number): Promise<void>;
  lookupReceipt(
    request: LookupStoredReceiptRequest,
  ): Promise<StoredTask | undefined>;
  submit(request: SubmitStoredTaskRequest): Promise<StoredMutationResult>;
  cancel(request: CancelStoredTaskRequest): Promise<StoredMutationResult>;
  transitionTasks(request: TransitionStoredTasksRequest): Promise<void>;
  claimAndPrepare(
    request: ClaimAndPrepareExecutionRequest,
  ): Promise<StoredExecution>;
  recoverExecutions(): Promise<void>;
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
  listTasks(request: {
    accessScopeId: string;
    allowedAgentIds: readonly string[];
    agentId?: string;
    state?: StoredTaskState;
    afterQueueOrder?: number;
    limit: number;
  }): Promise<{ tasks: StoredTask[]; lastQueueOrder?: number }>;
  getEvents(request: {
    accessScopeId: string;
    allowedAgentIds: readonly string[];
    taskId?: string;
    afterCursor?: number;
    limit: number;
  }): Promise<{ events: StoredEvent[]; lastCursor?: number }>;
}
