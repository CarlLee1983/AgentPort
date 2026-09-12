import type {
  CancelStoredTaskRequest,
  LookupStoredReceiptRequest,
  StoredEvent,
  StoredMutationResult,
  StoredTask,
  StoredTaskState,
  SubmitStoredTaskRequest,
  TransitionStoredTasksRequest,
} from "../storage/sqlite-durable-admission-store.js";

export interface DurableAdmissionStore {
  installRegistryRevision(revision: number): Promise<void>;
  lookupReceipt(
    request: LookupStoredReceiptRequest,
  ): Promise<StoredTask | undefined>;
  submit(request: SubmitStoredTaskRequest): Promise<StoredMutationResult>;
  cancel(request: CancelStoredTaskRequest): Promise<StoredMutationResult>;
  transitionTasks(request: TransitionStoredTasksRequest): Promise<void>;
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
