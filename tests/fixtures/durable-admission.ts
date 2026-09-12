import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentRegistry,
  type RegistryConfiguration,
} from "../../src/bootstrap/registry.js";
import {
  DurableAgentExecutionService,
  type ServiceOptions,
} from "../../src/core/agent-execution-service.js";
import {
  SqliteDurableAdmissionStore,
  type DurableAdmissionStoreOptions,
} from "../../src/storage/sqlite-durable-admission-store.js";

export const SCOPE_A_TOKEN = "ap002-scope-a-token";
export const SCOPE_B_TOKEN = "ap002-scope-b-token";
export const INVALID_TOKEN = "ap002-invalid-token";

export interface DurableAdmissionFixture {
  directory: string;
  databasePath: string;
  registry: AgentRegistry;
  registryConfiguration: RegistryConfiguration;
  service: DurableAgentExecutionService;
  store: SqliteDurableAdmissionStore;
  close(): Promise<void>;
}

type StoreOverrides = Omit<DurableAdmissionStoreOptions, "databasePath">;

export async function createDurableAdmissionFixture(
  storeOverrides: StoreOverrides = {},
  serviceOverrides: Pick<ServiceOptions, "snapshotCacheEntries"> = {},
): Promise<DurableAdmissionFixture> {
  const directory = await mkdtemp(join(tmpdir(), "agentport-ap002-"));
  const workspaceA = join(directory, "workspace-a");
  const workspaceRevokable = join(directory, "workspace-revokable");
  const workspaceB = join(directory, "workspace-b");
  await Promise.all(
    [workspaceA, workspaceRevokable, workspaceB].map((path) => mkdir(path)),
  );

  const registryConfiguration: RegistryConfiguration = {
    credentials: {
      [SCOPE_A_TOKEN]: "principal-a",
      [SCOPE_B_TOKEN]: "principal-b",
    },
    principals: [
      {
        principalId: "principal-a",
        accessScopeId: "scope-a",
        active: true,
        allowedAgentIds: ["agent-a", "agent-revokable"],
      },
      {
        principalId: "principal-b",
        accessScopeId: "scope-b",
        active: true,
        allowedAgentIds: ["agent-b"],
      },
    ],
    agents: [
      {
        agentId: "agent-a",
        description: "Primary fixture Agent",
        workspacePath: workspaceA,
        configurationRevision: "fixture-config-1",
        runtimeDriver: "unreachable-fixture-driver",
        runtimeVersion: "0.0.0",
        policy: {
          maximumExecutionLimitSeconds: 3_600,
          maximumInputWaitSeconds: 86_400,
        },
      },
      {
        agentId: "agent-revokable",
        description: "Revocable fixture Agent",
        workspacePath: workspaceRevokable,
        configurationRevision: "fixture-config-1",
        runtimeDriver: "unreachable-fixture-driver",
        runtimeVersion: "0.0.0",
        policy: {
          maximumExecutionLimitSeconds: 3_600,
          maximumInputWaitSeconds: 86_400,
        },
      },
      {
        agentId: "agent-b",
        description: "Other-scope fixture Agent",
        workspacePath: workspaceB,
        configurationRevision: "fixture-config-1",
        runtimeDriver: "unreachable-fixture-driver",
        runtimeVersion: "0.0.0",
        policy: {
          maximumExecutionLimitSeconds: 3_600,
          maximumInputWaitSeconds: 86_400,
        },
      },
    ],
  };
  const databasePath = join(directory, "agentport.sqlite");
  const store = await SqliteDurableAdmissionStore.open({
    databasePath,
    ...storeOverrides,
  });
  const registry = await AgentRegistry.create(registryConfiguration, store);
  let sequence = 0;
  const service = new DurableAgentExecutionService(registry, store, {
    cursorSecret: "ap002-fixture-cursor-secret",
    newId: () => `fixture-id-${String(++sequence)}`,
    now: () => new Date("2026-09-12T08:00:00.000Z"),
    ...serviceOverrides,
  });
  await service.initializeAfterRestart();

  return {
    directory,
    databasePath,
    registry,
    registryConfiguration,
    service,
    store,
    close: async () => {
      await store.close();
      await rm(directory, { force: true, recursive: true });
    },
  };
}
