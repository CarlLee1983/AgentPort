import type { ExecutionReference } from "./types.js";

export interface StorageIncidentReporter {
  isLatched(): boolean;
  report(): void;
}

export interface StorageIncidentSafety extends StorageIncidentReporter {
  track(taskId: string, reference: ExecutionReference): void;
  assertStartAllowed(taskId: string, reference: ExecutionReference): void;
  release(taskId: string, reference?: ExecutionReference): void;
}
