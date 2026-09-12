import type { ExecutionReference } from "./types.js";

export type { ExecutionReference } from "./types.js";

export interface WorkerObservation {
  reference: ExecutionReference;
  kind: "progress";
  ordinal: number;
  summary: string;
}

export type SupervisorStartResult =
  { kind: "pending" } | { kind: "indeterminate" };

export type SupervisorStopResult = { kind: "indeterminate" };

export type SupervisorReconcileResult = { kind: "indeterminate" };

export interface ExecutionSupervisorAdapter {
  start(reference: ExecutionReference): Promise<unknown>;
  revokeAndStop(reference: ExecutionReference): Promise<unknown>;
  reconcile(reference: ExecutionReference): Promise<unknown>;
}

export interface ExecutionSupervisor {
  start(reference: ExecutionReference): Promise<SupervisorStartResult>;
  revokeAndStop(reference: ExecutionReference): Promise<SupervisorStopResult>;
  reconcile(reference: ExecutionReference): Promise<SupervisorReconcileResult>;
}

function referenceKey(reference: ExecutionReference): string {
  return [
    reference.executionId,
    reference.generation,
    reference.daemonEpoch,
    reference.launchProfileId,
    reference.workspaceIdentity,
  ].join("\u0000");
}

function sameReference(
  expected: ExecutionReference,
  value: unknown,
): value is ExecutionReference {
  return (
    isRecord(value) &&
    value.executionId === expected.executionId &&
    value.generation === expected.generation &&
    value.daemonEpoch === expected.daemonEpoch &&
    value.launchProfileId === expected.launchProfileId &&
    value.workspaceIdentity === expected.workspaceIdentity
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates bounded, Reference-bound IPC without persisting an outcome or dispatching work. */
export function parseWorkerObservation(
  reference: ExecutionReference,
  value: unknown,
): WorkerObservation | undefined {
  if (
    !isRecord(value) ||
    value.kind !== "progress" ||
    !sameReference(reference, value.reference) ||
    !Number.isSafeInteger(value.ordinal) ||
    Number(value.ordinal) < 1 ||
    typeof value.summary !== "string" ||
    Buffer.byteLength(value.summary, "utf8") > 1024
  ) {
    return undefined;
  }
  return {
    reference,
    kind: "progress",
    ordinal: Number(value.ordinal),
    summary: value.summary,
  };
}

export function createExecutionSupervisor(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- AP-003 deliberately withholds this capability until S3 evidence exists.
  _adapter: ExecutionSupervisorAdapter,
): ExecutionSupervisor {
  const closed = new Set<string>();
  const executionReferences = new Map<string, string>();
  const starts = new Map<string, Promise<SupervisorStartResult>>();
  const stops = new Map<string, Promise<SupervisorStopResult>>();

  function currentReference(reference: ExecutionReference): boolean {
    const key = referenceKey(reference);
    const existing = executionReferences.get(reference.executionId);
    if (existing !== undefined) return existing === key;
    executionReferences.set(reference.executionId, key);
    return true;
  }

  return {
    async start(reference) {
      const key = referenceKey(reference);
      if (!currentReference(reference)) return { kind: "indeterminate" };
      if (closed.has(key)) return { kind: "pending" };
      let pending = starts.get(key);
      if (pending === undefined) {
        // AP-003 must model an untrusted fixture without calling an Adapter.
        pending = Promise.resolve({ kind: "indeterminate" });
        starts.set(key, pending);
      }
      const result = await pending;
      return closed.has(key) ? { kind: "pending" } : result;
    },
    async revokeAndStop(reference) {
      const key = referenceKey(reference);
      if (!currentReference(reference)) return { kind: "indeterminate" };
      closed.add(key);
      let pending = stops.get(key);
      if (pending === undefined) {
        pending = Promise.resolve({ kind: "indeterminate" });
        stops.set(key, pending);
      }
      return pending;
    },
    reconcile(reference) {
      if (!currentReference(reference)) {
        return Promise.resolve({ kind: "indeterminate" });
      }
      return Promise.resolve({ kind: "indeterminate" });
    },
  };
}
