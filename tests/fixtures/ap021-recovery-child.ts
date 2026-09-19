import { stdout } from "node:process";

import { createControlledRuntimeAdmission } from "../../src/bootstrap/create-controlled-runtime-admission.js";
import { AgentRegistry } from "../../src/bootstrap/registry.js";
import { DurableAgentExecutionService } from "../../src/core/agent-execution-service.js";
import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";

interface Request {
  action: "prepare" | "recover";
  databasePath: string;
  workspacePath: string;
  socketPath: string;
  socketGroupId: number;
  ingressDirectory: string;
  runtimeGroupId: number;
  ingressGroupId: number;
  activeTaskId?: string;
  queuedTaskId?: string;
}

const actor = { principalId: "principal-ap021" };
const CONTINUATION_KEY = "A".repeat(43);

async function readRequest(): Promise<Request> {
  process.stdin.setEncoding("utf8");
  let body = "";
  for await (const chunk of process.stdin) body += String(chunk);
  return JSON.parse(body) as Request;
}

function registryConfiguration(workspacePath: string) {
  return {
    credentials: { "ap021-recovery-token": actor.principalId },
    principals: [
      {
        principalId: actor.principalId,
        accessScopeId: "scope-ap021",
        active: true,
        allowedAgentIds: ["agent-ap021"],
      },
    ],
    agents: [
      {
        agentId: "agent-ap021",
        description: "AP-021 non-root recovery fixture",
        workspacePath,
        configurationRevision: "ap021-recovery-v1",
        runtimeDriver: "fixture",
        runtimeVersion: "1",
        launchProfileId: "g1-recovery",
        policy: {
          maximumExecutionLimitSeconds: 3_600,
          maximumInputWaitSeconds: 86_400,
        },
      },
    ],
  };
}

function configuration(request: Request) {
  return {
    registry: registryConfiguration(request.workspacePath),
    cursorSecret: "ap021-recovery-cursor-secret",
    storage: {
      databasePath: request.databasePath,
      continuationEncryptionKey: CONTINUATION_KEY,
    },
    launcher: {
      socketPath: request.socketPath,
      workerIngressDirectory: request.ingressDirectory,
      socketGroupId: request.socketGroupId,
      runtimeGroupId: request.runtimeGroupId,
      ingressGroupId: request.ingressGroupId,
    },
  };
}

async function prepare(request: Request, uid: number): Promise<never> {
  const composition = await createControlledRuntimeAdmission(
    configuration(request),
  );
  const active = await composition.service.submitTask(actor, {
    operationId: "ap021-recovery-active",
    agentId: "agent-ap021",
    instruction: "Remain active across the daemon crash fixture.",
  });
  const started = await composition.dispatch(active.task.taskId);
  if (started.kind !== "started" || active.task.execution !== null) {
    throw new Error(
      `AP-021 recovery fixture failed to start an Execution: ${started.kind}`,
    );
  }
  const running = await composition.service.getTask(actor, {
    taskId: active.task.taskId,
  });
  if (running.execution === null) {
    throw new Error("AP-021 recovery fixture has no durable Execution");
  }
  const queued = await composition.service.submitTask(actor, {
    operationId: "ap021-recovery-queued",
    agentId: "agent-ap021",
    instruction: "Pause this queued Task when the daemon restarts.",
  });
  stdout.write(
    `${JSON.stringify({
      uid,
      result: {
        activeTaskId: active.task.taskId,
        queuedTaskId: queued.task.taskId,
        executionId: running.execution.executionId,
      },
    })}\n`,
    () => process.exit(0),
  );
  return await new Promise<never>(() => undefined);
}

async function recover(request: Request, uid: number): Promise<void> {
  let rejected = false;
  try {
    await createControlledRuntimeAdmission(configuration(request));
  } catch (error) {
    rejected =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "storage_unavailable";
  }
  if (!rejected) {
    throw new Error("Unknown Linux Execution did not block recovery");
  }

  const store = await SqliteDurableAdmissionStore.open({
    databasePath: request.databasePath,
    continuationEncryptionKey: CONTINUATION_KEY,
    recoveryOnly: true,
  });
  try {
    const registry = await AgentRegistry.create(
      registryConfiguration(request.workspacePath),
      store,
    );
    const service = new DurableAgentExecutionService(registry, store, {
      cursorSecret: "ap021-recovery-cursor-secret",
    });
    if (
      request.activeTaskId === undefined ||
      request.queuedTaskId === undefined
    ) {
      throw new Error("Recovery Task identities are required");
    }
    const [active, queued] = await Promise.all([
      service.getTask(actor, { taskId: request.activeTaskId }),
      service.getTask(actor, { taskId: request.queuedTaskId }),
    ]);
    if (
      active.state !== "recovering" ||
      active.execution?.quarantined !== true ||
      queued.state !== "paused" ||
      queued.reason !== "daemon_restart"
    ) {
      throw new Error("AP-021 recovery state did not remain fail-closed");
    }
    stdout.write(
      `${JSON.stringify({
        uid,
        result: {
          activeState: active.state,
          activeQuarantined: active.execution.quarantined,
          queuedState: queued.state,
          queuedReason: queued.reason,
        },
      })}\n`,
    );
  } finally {
    await store.close();
  }
}

const uid = process.getuid?.();
if (uid === undefined || uid === 0) {
  throw new Error("AP-021 recovery fixture must run as the non-root daemon");
}
const request = await readRequest();
if (request.action === "prepare") await prepare(request, uid);
else await recover(request, uid);
