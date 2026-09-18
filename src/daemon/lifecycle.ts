import type { ControlledRuntimeAdmissionComposition } from "../bootstrap/create-controlled-runtime-admission.js";
import {
  LoopbackListenerBindError,
  startLoopbackDurableAdmissionServer,
  type LoopbackDurableAdmissionServer,
} from "../mcp/loopback-server.js";
import type { DaemonConfiguration } from "./configuration.js";
import type { DaemonCredentials } from "./credentials.js";
import { prepareProductionDaemonComposition } from "./composition.js";

export const DAEMON_SHUTDOWN_DEADLINE_MS = 25_000;
export const DAEMON_STARTUP_FAILED = "daemon_startup_failed";
export const DAEMON_SHUTDOWN_FAILED = "daemon_shutdown_failed";

export type DaemonLifecycleState =
  "starting" | "running" | "stopping" | "stopped";

export interface DaemonLifecycleControl {
  readonly state: DaemonLifecycleState;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class DaemonLifecycleError extends Error {
  constructor(
    readonly code: typeof DAEMON_STARTUP_FAILED | typeof DAEMON_SHUTDOWN_FAILED,
  ) {
    super(code);
    this.name = "DaemonLifecycleError";
  }
}

export interface ProductionDaemonLifecycleDependencies {
  prepareComposition(
    configuration: DaemonConfiguration,
    credentials: DaemonCredentials,
  ): Promise<ControlledRuntimeAdmissionComposition>;
  startListener(options: {
    composition: ControlledRuntimeAdmissionComposition;
    port: number;
    canAcceptRequest: () => boolean;
  }): Promise<LoopbackDurableAdmissionServer>;
}

const defaultDependencies: ProductionDaemonLifecycleDependencies = {
  prepareComposition: (configuration, credentials) =>
    prepareProductionDaemonComposition(configuration, credentials),
  startListener: ({ composition, port, canAcceptRequest }) =>
    startLoopbackDurableAdmissionServer({
      registry: composition.registry,
      handler: composition.mcpHandler,
      auditRecorder: composition.auditRecorder,
      port,
      canAcceptRequest,
    }),
};

function deadlineAfter(milliseconds: number): number {
  return performance.now() + milliseconds;
}

async function beforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
): Promise<T> {
  const remaining = Math.max(0, deadline - performance.now());
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DaemonLifecycleError(DAEMON_SHUTDOWN_FAILED));
    }, remaining);
    timer.unref();
  });
  try {
    return await Promise.race([operation, timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Owns only service-process lifecycle. Task lifecycle remains in the existing
 * service/store/Supervisor composition.
 */
export class ProductionDaemonLifecycle implements DaemonLifecycleControl {
  #state: DaemonLifecycleState = "stopped";
  #stopRequested = false;
  #stopFinished = false;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #composition: ControlledRuntimeAdmissionComposition | undefined;
  #listener: LoopbackDurableAdmissionServer | undefined;

  constructor(
    private readonly configuration: DaemonConfiguration,
    private readonly credentials: DaemonCredentials,
    private readonly dependencies = defaultDependencies,
    private readonly shutdownDeadlineMs = DAEMON_SHUTDOWN_DEADLINE_MS,
  ) {
    if (!Number.isSafeInteger(shutdownDeadlineMs) || shutdownDeadlineMs < 1) {
      throw new TypeError("shutdownDeadlineMs must be a positive safe integer");
    }
  }

  get state(): DaemonLifecycleState {
    return this.#state;
  }

  get url(): URL | undefined {
    return this.#listener?.url;
  }

  #isStopRequested(): boolean {
    return this.#stopRequested;
  }

  start(): Promise<void> {
    if (this.#startPromise !== undefined) return this.#startPromise;
    if (this.#stopPromise !== undefined || this.#stopRequested) {
      return Promise.reject(new DaemonLifecycleError(DAEMON_STARTUP_FAILED));
    }
    this.#state = "starting";
    this.#startPromise = this.#start().catch(async (error: unknown) => {
      this.#state = "stopping";
      this.#listener?.stopAccepting();
      this.#composition?.beginShutdown();
      try {
        await beforeDeadline(
          this.#closeOwnedResources(),
          deadlineAfter(this.shutdownDeadlineMs),
        );
      } catch {
        await this.#forceCloseOwnedResources();
      }
      this.#state = "stopped";
      if (error instanceof LoopbackListenerBindError) throw error;
      throw new DaemonLifecycleError(DAEMON_STARTUP_FAILED);
    });
    return this.#startPromise;
  }

  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#stopRequested = true;
    this.#state = "stopping";
    this.#listener?.stopAccepting();
    this.#composition?.beginShutdown();
    this.#stopPromise = this.#stop();
    return this.#stopPromise;
  }

  async #start(): Promise<void> {
    this.#composition = await this.dependencies.prepareComposition(
      this.configuration,
      this.credentials,
    );
    if (this.#isStopRequested()) {
      this.#composition.beginShutdown();
      if (this.#stopFinished) await this.#forceCloseOwnedResources();
      return;
    }

    this.#listener = await this.dependencies.startListener({
      composition: this.#composition,
      port: this.configuration.mcp.port,
      canAcceptRequest: () => this.#state === "running",
    });
    if (this.#isStopRequested()) {
      this.#listener.stopAccepting();
      this.#composition.beginShutdown();
      if (this.#stopFinished) await this.#forceCloseOwnedResources();
      return;
    }

    await this.#composition.initializeAfterRestart();
    if (this.#isStopRequested()) {
      if (this.#stopFinished) await this.#forceCloseOwnedResources();
      return;
    }
    this.#state = "running";
  }

  async #stop(): Promise<void> {
    const deadline = deadlineAfter(this.shutdownDeadlineMs);
    let failed = false;
    try {
      if (this.#startPromise !== undefined) {
        await beforeDeadline(
          this.#startPromise.catch(() => undefined),
          deadline,
        );
      }
      this.#listener?.stopAccepting();
      this.#composition?.beginShutdown();
      if (this.#listener !== undefined) {
        await beforeDeadline(this.#listener.drainRequests(), deadline);
      }
      if (this.#composition !== undefined) {
        const shutdown = await beforeDeadline(
          this.#composition.prepareForDaemonShutdown(),
          deadline,
        );
        if (shutdown.stopUnknown > 0) failed = true;
      }
    } catch {
      failed = true;
    }

    try {
      await beforeDeadline(this.#closeOwnedResources(), deadline);
    } catch {
      failed = true;
      await this.#forceCloseOwnedResources();
    }
    this.#state = "stopped";
    this.#stopFinished = true;
    if (failed) throw new DaemonLifecycleError(DAEMON_SHUTDOWN_FAILED);
  }

  async #closeOwnedResources(): Promise<void> {
    const listener = this.#listener;
    const composition = this.#composition;
    let failure: unknown;
    if (listener !== undefined) {
      listener.stopAccepting();
      try {
        await listener.close();
      } catch (error) {
        failure = error;
      }
    }
    if (composition !== undefined) {
      try {
        await composition.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) {
      throw new Error("daemon resource close failed", { cause: failure });
    }
    if (this.#listener === listener) this.#listener = undefined;
    if (this.#composition === composition) this.#composition = undefined;
  }

  async #forceCloseOwnedResources(): Promise<void> {
    const listener = this.#listener;
    const composition = this.#composition;
    this.#listener = undefined;
    this.#composition = undefined;
    try {
      listener?.forceClose();
    } catch {
      // Deadline cleanup is best-effort but must never become unbounded.
    }
    if (composition !== undefined) {
      await Promise.allSettled([composition.forceClose()]);
    }
  }
}
