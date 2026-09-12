import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";

type StoreOptions = Omit<
  ConstructorParameters<typeof SqliteDurableAdmissionStore>[0],
  "databasePath"
>;

export async function openStore(options: StoreOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "agentport-storage-"));
  const store = await SqliteDurableAdmissionStore.open({
    ...options,
    databasePath: join(directory, "store.sqlite"),
  });
  return {
    directory,
    store,
    async dispose() {
      await store.close();
      await rm(directory, { force: true, recursive: true });
    },
  };
}

export function submit(
  overrides: Partial<Parameters<SqliteDurableAdmissionStore["submit"]>[0]> = {},
) {
  return {
    accessScopeId: "scope-a",
    operationId: "submit-1",
    fingerprint: "submit-fingerprint",
    principalId: "principal-a",
    taskId: "task-1",
    contextId: "context-1",
    agentId: "agent-a",
    instruction: "durable task",
    binding: {
      bindingSnapshotId: "binding-1",
      configurationRevision: "opaque-revision",
      workspaceIdentity: {
        canonicalPath: "/fixture/workspace-a",
        filesystemIdentity: "workspace-a",
      },
      runtimeDriver: "none",
      runtimeVersion: "none",
      policy: {
        maximumExecutionLimitSeconds: 3_600,
        maximumInputWaitSeconds: 86_400,
      },
    },
    ...overrides,
  };
}
