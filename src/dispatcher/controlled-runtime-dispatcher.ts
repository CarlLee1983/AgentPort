import type {
  ExecutionSupervisor,
  RuntimeIngressDescriptor,
} from "../core/execution-supervisor.js";
import type { ControlledRuntimeDispatchLifecycle } from "../core/agent-execution-service.js";
import type { ExecutionReference } from "../core/types.js";
import type { RuntimeWorkerIngressLifecycle } from "../runtime/worker/ingress.js";

export interface DispatchAuthoritySource {
  dispatchAuthority(): Promise<string | undefined>;
}

export interface RuntimeIngressFactory {
  open(input: {
    taskId: string;
    reference: ExecutionReference;
    lifecycle: RuntimeWorkerIngressLifecycle;
  }): Promise<{ session: RuntimeIngressDescriptor; close(): Promise<void> }>;
}

/** Coordinates launcher I/O while the core remains the lifecycle owner. */
export class ControlledRuntimeDispatcher {
  constructor(
    private readonly lifecycle: ControlledRuntimeDispatchLifecycle,
    private readonly launcher: DispatchAuthoritySource,
    private readonly supervisor: ExecutionSupervisor,
    private readonly ingressFactory?: RuntimeIngressFactory,
  ) {}

  async dispatch(
    taskId: string,
  ): Promise<
    { kind: "started" } | { kind: "unavailable" } | { kind: "indeterminate" }
  > {
    const daemonEpoch = await this.launcher.dispatchAuthority();
    if (daemonEpoch === undefined) return { kind: "unavailable" };
    const preparation = await this.lifecycle.prepareForDispatch(
      taskId,
      daemonEpoch,
    );
    const { reference } = preparation;
    let ingress: Awaited<ReturnType<RuntimeIngressFactory["open"]>> | undefined;
    let result;
    try {
      if (this.ingressFactory !== undefined) {
        ingress = await this.ingressFactory.open({
          taskId,
          reference,
          lifecycle: {
            persistQuestion: (question) =>
              this.lifecycle.persistRuntimeQuestion(taskId, question),
            waitForAcceptedAnswer: (value, identity, signal) =>
              this.lifecycle.waitForAcceptedQuestionAnswer(
                value,
                identity,
                signal,
              ),
            acknowledgeQuestionDelivery: (value, identity) =>
              this.lifecycle.acknowledgeRuntimeQuestionDelivery(
                value,
                identity,
              ),
            markQuestionDeliveryUnknown: (value, identity) =>
              this.lifecycle.markRuntimeQuestionDeliveryUnknown(
                value,
                identity,
              ),
            recordObservation: (observation) =>
              this.lifecycle
                .recordRuntimeObservation(taskId, observation)
                .then(() => undefined),
            stopAfterCandidate: async (value) => {
              try {
                await this.#stopAndTerminalize(value);
              } finally {
                await ingress?.close().catch(() => undefined);
              }
            },
            quarantine: async (value) => {
              try {
                await this.lifecycle.interruptRuntime(value);
                await this.#stopAndTerminalize(value);
              } finally {
                await ingress?.close().catch(() => undefined);
              }
            },
          },
        });
      }
      // This synchronous fence and the start call share one main-thread turn;
      // an already-observed storage incident cannot cross the final start seam.
      this.lifecycle.assertDispatchStartAllowed(taskId, reference);
      result = await this.supervisor.start(
        reference,
        ingress?.session,
        preparation.continuation,
        preparation.policy,
      );
    } catch {
      await ingress?.close().catch(() => undefined);
      await this.#stopAndQuarantine(reference);
      return { kind: "indeterminate" };
    }
    if (result.kind !== "started") {
      await ingress?.close().catch(() => undefined);
      await this.#stopAndQuarantine(reference);
      return result.kind === "unavailable"
        ? { kind: "unavailable" }
        : { kind: "indeterminate" };
    }
    try {
      const acknowledgement =
        await this.lifecycle.markExecutionRunning(reference);
      if (acknowledgement.kind === "stop_required") {
        await ingress?.close().catch(() => undefined);
        await this.#stopAndQuarantine(reference);
        return { kind: "indeterminate" };
      }
    } catch {
      await ingress?.close().catch(() => undefined);
      await this.#stopAndQuarantine(reference);
      return { kind: "indeterminate" };
    }
    return { kind: "started" };
  }

  async #stopAndQuarantine(
    reference: Parameters<ExecutionSupervisor["start"]>[0],
  ): Promise<void> {
    try {
      await this.supervisor.revokeAndStop(reference);
    } catch {
      // A failed stop confirmation is indeterminate; durable quarantine retains the claim.
    }
    try {
      await this.lifecycle.quarantineAfterDispatch(reference);
    } catch {
      // A cancellation winner is already durably stopping and must not be replaced.
    }
  }

  async #stopAndTerminalize(reference: ExecutionReference): Promise<void> {
    try {
      const stopped = await this.supervisor.revokeAndStop(reference);
      if (stopped.kind === "stopped") {
        await this.lifecycle.commitVerifiedStop(stopped.evidence);
      }
    } catch {
      // Durable stopping state and its claim remain until a later trusted stop.
    }
  }
}
