import type { ExecutionSupervisor } from "../core/execution-supervisor.js";
import { ApplicationError } from "../core/errors.js";
import type { StorageIncidentSafety } from "../core/storage-incident-safety.js";
import type { ExecutionReference } from "../core/types.js";

function referenceKey(reference: ExecutionReference): string {
  return [
    reference.executionId,
    reference.generation,
    reference.daemonEpoch,
    reference.launchProfileId,
    reference.workspaceIdentity,
  ].join("\u0000");
}

/**
 * Controlled-composition fail-stop safety state. SQLite remains lifecycle
 * truth; this bounded set can only fence and stop exact References while down.
 */
export class StorageIncidentCoordinator implements StorageIncidentSafety {
  readonly #active = new Map<string, ExecutionReference>();
  readonly #stops = new Map<string, Promise<void>>();
  #latched = false;

  constructor(
    private readonly supervisor: ExecutionSupervisor,
    private readonly maximumActiveReferences: number,
  ) {
    if (
      !Number.isSafeInteger(maximumActiveReferences) ||
      maximumActiveReferences < 1
    ) {
      throw new TypeError(
        "maximumActiveReferences must be a positive safe integer",
      );
    }
  }

  isLatched(): boolean {
    return this.#latched;
  }

  track(taskId: string, reference: ExecutionReference): void {
    if (this.#latched) {
      throw new ApplicationError(
        "storage_unavailable",
        "Durable storage is unavailable",
      );
    }
    const existing = this.#active.get(taskId);
    if (existing !== undefined) {
      if (referenceKey(existing) === referenceKey(reference)) return;
      throw new ApplicationError(
        "operation_conflict",
        "Task already has an active Execution Reference",
      );
    }
    if (this.#active.size >= this.maximumActiveReferences) {
      throw new ApplicationError(
        "storage_capacity",
        "Execution safety capacity is exhausted",
      );
    }
    this.#active.set(taskId, { ...reference });
  }

  assertStartAllowed(taskId: string, reference: ExecutionReference): void {
    if (this.#latched) {
      throw new ApplicationError(
        "storage_unavailable",
        "Durable storage is unavailable",
      );
    }
    const existing = this.#active.get(taskId);
    if (
      existing === undefined ||
      referenceKey(existing) !== referenceKey(reference)
    ) {
      throw new ApplicationError(
        "operation_conflict",
        "Execution Reference is not active",
      );
    }
  }

  release(taskId: string, reference?: ExecutionReference): void {
    const existing = this.#active.get(taskId);
    if (existing === undefined) return;
    if (
      reference !== undefined &&
      referenceKey(existing) !== referenceKey(reference)
    ) {
      return;
    }
    this.#active.delete(taskId);
  }

  report(): void {
    if (this.#latched) return;
    this.#latched = true;
    for (const reference of this.#active.values()) {
      void this.#stop(reference);
    }
  }

  #stop(reference: ExecutionReference): Promise<void> {
    const key = referenceKey(reference);
    let stop = this.#stops.get(key);
    if (stop === undefined) {
      stop = this.supervisor
        .revokeAndStop(reference)
        .then(() => undefined)
        .catch(() => undefined);
      this.#stops.set(key, stop);
    }
    return stop;
  }
}
