import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

import type { McpHttpHandler } from "@modelcontextprotocol/server";

import {
  DurableAgentExecutionService,
  type StopEvidenceVerifier,
} from "../core/agent-execution-service.js";
import type { AgentExecutionService } from "../core/types.js";
import {
  ControlledRuntimeDispatcher,
  type RuntimeIngressFactory,
} from "../dispatcher/controlled-runtime-dispatcher.js";
import { createDurableAdmissionMcpHandler } from "../mcp/adapter.js";
import { RuntimeWorkerIngress } from "../runtime/worker/ingress.js";
import {
  isVerifiedLinuxStopEvidence,
  LinuxExecutionSupervisor,
} from "../supervisor/linux/execution-supervisor.js";
import { LinuxLauncherClient } from "../supervisor/linux/launcher-client.js";
import {
  SqliteDurableAdmissionStore,
  type DurableAdmissionStoreOptions,
} from "../storage/sqlite-durable-admission-store.js";
import { AgentRegistry, type RegistryConfiguration } from "./registry.js";

export interface ControlledRuntimeAdmissionConfiguration {
  registry: RegistryConfiguration;
  cursorSecret: string;
  storage: DurableAdmissionStoreOptions;
  launcher: {
    socketPath: string;
    workerIngressDirectory: string;
    runtimeGroupId: number;
  };
}

export interface ControlledRuntimeAdmissionComposition {
  registry: AgentRegistry;
  service: AgentExecutionService;
  mcpHandler: McpHttpHandler;
  /** Internal scheduler seam; no MCP caller can select a Reference or profile. */
  dispatch(taskId: string): ReturnType<ControlledRuntimeDispatcher["dispatch"]>;
  close(): Promise<void>;
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

async function verifyIngressDirectory(
  directory: string,
  runtimeGroupId: number,
): Promise<string> {
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 0 ||
    !Number.isSafeInteger(runtimeGroupId) ||
    runtimeGroupId < 1
  ) {
    throw new Error(
      "Controlled Runtime composition requires protected Linux ingress",
    );
  }
  const canonical = await realpath(directory);
  const metadata = await lstat(canonical);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    metadata.gid !== runtimeGroupId ||
    (metadata.mode & 0o027) !== 0
  ) {
    throw new Error(
      "Worker ingress directory is not protected for the Runtime identity",
    );
  }
  return canonical;
}

/**
 * Explicit S3-B composition.  The S3-A composition intentionally remains in
 * create-durable-admission.ts and has no runtime imports or process control.
 */
export async function createControlledRuntimeAdmission(
  configuration: ControlledRuntimeAdmissionConfiguration,
): Promise<ControlledRuntimeAdmissionComposition> {
  if (configuration.storage.continuationEncryptionKey === undefined) {
    throw new Error(
      "Controlled Runtime composition requires continuationEncryptionKey",
    );
  }
  const ingressDirectory = await verifyIngressDirectory(
    configuration.launcher.workerIngressDirectory,
    configuration.launcher.runtimeGroupId,
  );
  const store = await SqliteDurableAdmissionStore.open(configuration.storage);
  try {
    const registry = await AgentRegistry.create(configuration.registry, store);
    const launcher = new LinuxLauncherClient({
      socketPath: configuration.launcher.socketPath,
    });
    const supervisor = new LinuxExecutionSupervisor(launcher);
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
    });
    const ingressFactory: RuntimeIngressFactory = {
      async open({ reference, lifecycle }) {
        // Linux pathname sockets are bounded; execution IDs are generated opaque identifiers.
        const endpoint = join(ingressDirectory, `${randomUUID()}.sock`);
        const ingress = await RuntimeWorkerIngress.open({
          endpoint,
          reference,
          lifecycle,
          groupId: configuration.launcher.runtimeGroupId,
        });
        return { session: ingress.session, close: () => ingress.close() };
      },
    };
    const dispatcher = new ControlledRuntimeDispatcher(
      service,
      launcher,
      supervisor,
      ingressFactory,
    );
    await service.initializeAfterRestart(supervisor);
    const mcpHandler = createDurableAdmissionMcpHandler(service);
    return {
      registry,
      service,
      mcpHandler,
      dispatch: (taskId) => dispatcher.dispatch(taskId),
      close: async () => {
        try {
          await mcpHandler.close();
        } finally {
          await store.close();
        }
      },
    };
  } catch (error) {
    await store.close();
    throw error;
  }
}
