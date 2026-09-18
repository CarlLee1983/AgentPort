import { pathToFileURL } from "node:url";

import { LoopbackListenerBindError } from "../mcp/loopback-server.js";
import {
  DaemonConfigurationError,
  readProtectedDaemonConfiguration,
  type DaemonConfiguration,
} from "./configuration.js";
import {
  DaemonCredentialError,
  readSystemdDaemonCredentials,
  type DaemonCredentials,
} from "./credentials.js";
import {
  type DaemonLifecycleControl,
  DaemonLifecycleError,
  ProductionDaemonLifecycle,
} from "./lifecycle.js";

export const DAEMON_ARGUMENTS_INVALID = "daemon_arguments_invalid";
export const DAEMON_ROOT_FORBIDDEN = "daemon_root_forbidden";

export class DaemonCliError extends Error {
  constructor(
    readonly code:
      typeof DAEMON_ARGUMENTS_INVALID | typeof DAEMON_ROOT_FORBIDDEN,
  ) {
    super(code);
    this.name = "DaemonCliError";
  }
}

export interface DaemonMainDependencies {
  getUid(): number | undefined;
  readConfiguration(path: string): Promise<DaemonConfiguration>;
  readCredentials(): Promise<DaemonCredentials>;
  createLifecycle(
    configuration: DaemonConfiguration,
    credentials: DaemonCredentials,
  ): DaemonLifecycleControl;
  onSignal(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  offSignal(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  writeError(line: string): void;
}

const defaultDependencies: DaemonMainDependencies = {
  getUid: () => process.getuid?.(),
  readConfiguration: readProtectedDaemonConfiguration,
  readCredentials: () => readSystemdDaemonCredentials(),
  createLifecycle: (configuration, credentials) =>
    new ProductionDaemonLifecycle(configuration, credentials),
  onSignal: (signal, listener) => process.on(signal, listener),
  offSignal: (signal, listener) => process.off(signal, listener),
  writeError: (line) => process.stderr.write(`${line}\n`),
};

export function parseDaemonArguments(arguments_: readonly string[]): string {
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--config" ||
    arguments_[1] === undefined ||
    arguments_[1].length === 0
  ) {
    throw new DaemonCliError(DAEMON_ARGUMENTS_INVALID);
  }
  return arguments_[1];
}

function safeReasonCode(error: unknown): string {
  if (
    error instanceof DaemonCliError ||
    error instanceof DaemonConfigurationError ||
    error instanceof DaemonCredentialError ||
    error instanceof DaemonLifecycleError ||
    error instanceof LoopbackListenerBindError
  ) {
    return error.code;
  }
  return "daemon_startup_failed";
}

/** Runs until SIGINT/SIGTERM and never calls process.exit(). */
export async function runProductionDaemon(
  arguments_: readonly string[],
  dependencies: DaemonMainDependencies = defaultDependencies,
): Promise<void> {
  const configurationPath = parseDaemonArguments(arguments_);
  if (dependencies.getUid() === 0) {
    throw new DaemonCliError(DAEMON_ROOT_FORBIDDEN);
  }

  let lifecycle: DaemonLifecycleControl | undefined;
  let stopPromise: Promise<void> | undefined;
  let resolveSignal: (() => void) | undefined;
  const signalReceived = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  const handleSignal = (): void => {
    resolveSignal?.();
    if (lifecycle !== undefined) {
      stopPromise ??= lifecycle.stop();
      void stopPromise.catch(() => undefined);
    }
  };
  const waitOrSignal = <T>(operation: Promise<T>) =>
    Promise.race([
      operation.then((value) => ({ kind: "completed", value }) as const),
      signalReceived.then(() => ({ kind: "signal" }) as const),
    ]);
  dependencies.onSignal("SIGINT", handleSignal);
  dependencies.onSignal("SIGTERM", handleSignal);

  try {
    const configurationResult = await waitOrSignal(
      dependencies.readConfiguration(configurationPath),
    );
    if (configurationResult.kind === "signal") return;
    const configuration = configurationResult.value;
    const credentialsResult = await waitOrSignal(
      dependencies.readCredentials(),
    );
    if (credentialsResult.kind === "signal") return;
    const credentials = credentialsResult.value;
    lifecycle = dependencies.createLifecycle(configuration, credentials);
    const startup = await waitOrSignal(lifecycle.start());
    if (startup.kind === "signal") {
      stopPromise ??= lifecycle.stop();
      await stopPromise;
      return;
    }
    if (lifecycle.state !== "running") {
      stopPromise ??= lifecycle.stop();
      await stopPromise;
      return;
    }
    await signalReceived;
    stopPromise ??= lifecycle.stop();
    await stopPromise;
  } finally {
    dependencies.offSignal("SIGINT", handleSignal);
    dependencies.offSignal("SIGTERM", handleSignal);
  }
}

export async function daemonMain(
  arguments_ = process.argv.slice(2),
  dependencies: DaemonMainDependencies = defaultDependencies,
): Promise<number> {
  try {
    await runProductionDaemon(arguments_, dependencies);
    return 0;
  } catch (error) {
    dependencies.writeError(JSON.stringify({ code: safeReasonCode(error) }));
    return 1;
  }
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(entryPath).href
) {
  process.exitCode = await daemonMain();
}
