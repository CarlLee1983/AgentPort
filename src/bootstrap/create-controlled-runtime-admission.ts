import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

import type { McpHttpHandler } from "@modelcontextprotocol/server";

import {
  type DaemonShutdownResult,
  DurableAgentExecutionService,
  type StopEvidenceVerifier,
} from "../core/agent-execution-service.js";
import type { AgentExecutionService } from "../core/types.js";
import { ControlledRuntimeDispatcher } from "../dispatcher/controlled-runtime-dispatcher.js";
import { createDurableAdmissionMcpHandler } from "../mcp/adapter.js";
import { RuntimeWorkerIngress } from "../runtime/worker/ingress.js";
import {
  isVerifiedLinuxStopEvidence,
  LinuxExecutionSupervisor,
} from "../supervisor/linux/execution-supervisor.js";
import {
  assessProtectedIngressDirectory,
  lstatIngressPath,
  observeIngressDirectory,
} from "../supervisor/linux/ingress-directory.js";
import { LinuxLauncherClient } from "../supervisor/linux/launcher-client.js";
import {
  SqliteDurableAdmissionStore,
  type DurableAdmissionStoreOptions,
} from "../storage/sqlite-durable-admission-store.js";
import { AgentRegistry, type RegistryConfiguration } from "./registry.js";
import { StorageIncidentCoordinator } from "./storage-incident-coordinator.js";
import { verifyBeforeEachIngressOpen } from "./verified-ingress-factory.js";

export interface ControlledRuntimeAdmissionConfiguration {
  registry: RegistryConfiguration;
  cursorSecret: string;
  storage: DurableAdmissionStoreOptions;
  launcher: {
    socketPath: string;
    workerIngressDirectory: string;
    runtimeGroupId: number;
    ingressGroupId: number;
  };
}

export interface ControlledRuntimeAdmissionComposition {
  registry: AgentRegistry;
  service: AgentExecutionService;
  mcpHandler: McpHttpHandler;
  auditRecorder: Pick<
    SqliteDurableAdmissionStore,
    "flushAudit" | "recordAudit"
  >;
  /** Internal scheduler seam; no MCP caller can select a Reference or profile. */
  dispatch(taskId: string): ReturnType<ControlledRuntimeDispatcher["dispatch"]>;
  /** Must complete before admission or dispatch is opened. */
  initializeAfterRestart(): Promise<void>;
  /** Synchronous lifecycle fence: later dispatch attempts cannot claim or launch. */
  beginShutdown(): void;
  /** Administrative stop keeps active work in recovery until explicit acknowledgement. */
  prepareForDaemonShutdown(): Promise<DaemonShutdownResult>;
  close(): Promise<void>;
  /** Deadline fallback; terminates only resources owned by this daemon process. */
  forceClose(): Promise<void>;
}

function linuxStopEvidenceVerifier(): StopEvidenceVerifier {
  return {
    verify(value) {
      if (!isVerifiedLinuxStopEvidence(value)) return undefined;
      return {
        platform: value.platform,
        reference: { ...value.reference },
        executionUnitId: value.executionUnitId,
        generationSealedAt: value.generationSealedAt,
        unitEmptyObservedAt: value.unitEmptyObservedAt,
      };
    },
  };
}

const UNPROTECTED_INGRESS =
  "Worker ingress directory is not protected for the Runtime identity";

function requireNonRootLinux(): void {
  if (process.getuid?.() === 0) {
    throw new Error("Controlled Runtime composition must not run as root");
  }
  if (process.platform !== "linux") {
    throw new Error(
      "Controlled Runtime composition requires protected Linux ingress",
    );
  }
}

function validGroupId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

/**
 * Verifies the configured path itself, without resolving symlinks, so a
 * symlinked ingress directory or ancestor is refused (AP-021 R3). The daemon
 * never creates, chmods or chowns this launcher-owned directory.
 */
async function verifyIngressDirectory(
  directory: string,
  ingressGroupId: number,
): Promise<void> {
  if (!isAbsolute(directory) || normalize(directory) !== directory) {
    throw new Error(UNPROTECTED_INGRESS);
  }
  const assessment = assessProtectedIngressDirectory(
    await observeIngressDirectory(
      directory,
      process.getuid?.() ?? -1,
      lstatIngressPath,
    ),
    { ingressGroupId, allowRootProcess: false },
  );
  if (!assessment.ok) {
    throw new Error(UNPROTECTED_INGRESS, { cause: assessment });
  }
}

/** AP-021 R5: the launcher socket group is observed from the socket itself. */
async function verifyDistinctGroups(
  launcher: ControlledRuntimeAdmissionConfiguration["launcher"],
): Promise<void> {
  const socketGroupId = (await lstat(launcher.socketPath)).gid;
  if (
    launcher.ingressGroupId === socketGroupId ||
    launcher.runtimeGroupId === socketGroupId
  ) {
    throw new Error(
      "Controlled Runtime composition requires distinct ingress, socket and Runtime groups",
    );
  }
}

/**
 * The ingress socket exists between listen and chmod with umask-derived
 * permissions; a umask that denies other-write keeps the Runtime identity from
 * connecting inside that window.
 */
export function runtimeUmaskDeniesOtherWrite(status: string): boolean {
  const umask = /^Umask:\s+([0-7]+)$/m.exec(status)?.[1];
  return umask !== undefined && (Number.parseInt(umask, 8) & 0o002) !== 0;
}

async function requireRestrictiveUmask(): Promise<void> {
  const status = await readFile("/proc/self/status", "utf8");
  if (!runtimeUmaskDeniesOtherWrite(status)) {
    throw new Error(
      "Controlled Runtime composition requires a umask that denies other write",
    );
  }
}

/**
 * Explicit S3-B composition.  The S3-A composition intentionally remains in
 * create-durable-admission.ts and has no runtime imports or process control.
 */
export async function prepareControlledRuntimeAdmission(
  configuration: ControlledRuntimeAdmissionConfiguration,
): Promise<ControlledRuntimeAdmissionComposition> {
  requireNonRootLinux();
  const { launcher: launcherConfiguration } = configuration;
  if (
    !validGroupId(launcherConfiguration.ingressGroupId) ||
    !validGroupId(launcherConfiguration.runtimeGroupId) ||
    launcherConfiguration.ingressGroupId ===
      launcherConfiguration.runtimeGroupId
  ) {
    throw new Error(
      "Controlled Runtime composition requires distinct ingress, socket and Runtime groups",
    );
  }
  if (configuration.storage.continuationEncryptionKey === undefined) {
    throw new Error(
      "Controlled Runtime composition requires continuationEncryptionKey",
    );
  }
  const ingressDirectory = launcherConfiguration.workerIngressDirectory;
  await verifyIngressDirectory(
    ingressDirectory,
    launcherConfiguration.ingressGroupId,
  );
  await verifyDistinctGroups(launcherConfiguration);
  await requireRestrictiveUmask();
  let dispatchOpen = false;
  const launcher = new LinuxLauncherClient({
    socketPath: configuration.launcher.socketPath,
    canStart: () => dispatchOpen,
  });
  const supervisor = new LinuxExecutionSupervisor(launcher);
  const storageIncidents = new StorageIncidentCoordinator(
    supervisor,
    configuration.storage.activeExecutionCapacity ?? 4,
  );
  const store = await SqliteDurableAdmissionStore.open(
    configuration.storage,
    storageIncidents,
  );
  store.closeDispatchAdmission();
  try {
    const registry = await AgentRegistry.create(configuration.registry, store);
    const service = new DurableAgentExecutionService(registry, store, {
      cursorSecret: configuration.cursorSecret,
      stopRequester: {
        async requestStop(reference) {
          const result = await supervisor.revokeAndStop(reference);
          if (result.kind === "stopped") {
            await service.commitVerifiedStop(result.evidence);
          }
        },
      },
      stopEvidenceVerifier: linuxStopEvidenceVerifier(),
      storageIncidentSafety: storageIncidents,
    });
    const ingressFactory = verifyBeforeEachIngressOpen(
      {
        async open({ reference, lifecycle }) {
          // Linux pathname sockets are bounded; execution IDs are generated opaque identifiers.
          const endpoint = join(ingressDirectory, `${randomUUID()}.sock`);
          const ingress = await RuntimeWorkerIngress.open({
            endpoint,
            reference,
            lifecycle,
            groupId: launcherConfiguration.runtimeGroupId,
          });
          return { session: ingress.session, close: () => ingress.close() };
        },
      },
      () =>
        verifyIngressDirectory(
          ingressDirectory,
          launcherConfiguration.ingressGroupId,
        ),
    );
    const dispatcher = new ControlledRuntimeDispatcher(
      service,
      launcher,
      supervisor,
      ingressFactory,
      { isOpen: () => dispatchOpen },
    );
    const mcpHandler = createDurableAdmissionMcpHandler(service);
    let initialized = false;
    let shutdownRequested = false;
    let initializePromise: Promise<void> | undefined;
    let shutdownPromise: Promise<DaemonShutdownResult> | undefined;
    let closePromise: Promise<void> | undefined;
    const activeDispatches = new Set<
      ReturnType<ControlledRuntimeDispatcher["dispatch"]>
    >();
    return {
      registry,
      service,
      mcpHandler,
      auditRecorder: store,
      dispatch: (taskId) => {
        if (!dispatchOpen) return Promise.resolve({ kind: "unavailable" });
        const pending = dispatcher.dispatch(taskId);
        activeDispatches.add(pending);
        void pending.then(
          () => activeDispatches.delete(pending),
          () => activeDispatches.delete(pending),
        );
        return pending;
      },
      initializeAfterRestart: () => {
        initializePromise ??= (async () => {
          await service.initializeAfterRestart(supervisor);
          initialized = true;
          if (!shutdownRequested && closePromise === undefined) {
            store.openDispatchAdmission();
            dispatchOpen = true;
          }
        })();
        return initializePromise;
      },
      beginShutdown: () => {
        shutdownRequested = true;
        dispatchOpen = false;
        store.closeDispatchAdmission();
      },
      prepareForDaemonShutdown: () => {
        shutdownRequested = true;
        dispatchOpen = false;
        store.closeDispatchAdmission();
        shutdownPromise ??= (async () => {
          await Promise.allSettled(activeDispatches);
          if (!initialized) {
            return {
              activeExecutions: 0,
              stopConfirmed: 0,
              stopUnknown: 0,
            };
          }
          return service.prepareForDaemonShutdown(supervisor);
        })();
        return shutdownPromise;
      },
      close: () => {
        shutdownRequested = true;
        dispatchOpen = false;
        store.closeDispatchAdmission();
        closePromise ??= (async () => {
          await Promise.allSettled(activeDispatches);
          try {
            await mcpHandler.close();
          } finally {
            await store.close();
          }
        })();
        return closePromise;
      },
      forceClose: async () => {
        shutdownRequested = true;
        dispatchOpen = false;
        store.closeDispatchAdmission();
        void mcpHandler.close().catch(() => undefined);
        await store.forceClose();
      },
    };
  } catch (error) {
    await store.close();
    throw error;
  }
}

export async function createControlledRuntimeAdmission(
  configuration: ControlledRuntimeAdmissionConfiguration,
): Promise<ControlledRuntimeAdmissionComposition> {
  const composition = await prepareControlledRuntimeAdmission(configuration);
  try {
    await composition.initializeAfterRestart();
    return composition;
  } catch (error) {
    await composition.close().catch(() => undefined);
    throw error;
  }
}
