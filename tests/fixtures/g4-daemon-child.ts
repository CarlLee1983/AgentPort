import { randomBytes, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { createControlledRuntimeAdmission } from "../../src/bootstrap/create-controlled-runtime-admission.js";
import { startLoopbackDurableAdmissionServer } from "../../src/mcp/loopback-server.js";
import { MCP_PROTOCOL_VERSION } from "../../src/mcp/protocol.js";

/**
 * Runs the G4 native-Question-and-continuation interaction as the non-root
 * daemon account, spawned by `tests/claude/g4-mcp-interaction.test.ts` via
 * `runuser` (ADR-0006, AP-021 R1). The parent test prepares the root-owned
 * ingress directory and the daemon-owned database directory before spawning
 * this process; this file never touches uid 0 setup and prints exactly one
 * sanitized JSON line so the parent can assert on it without re-reading any
 * path, token or prompt this process handled.
 */

const PROFILE = "g4-claude-interaction";
const TOKEN_A = "agentport-g4-principal-a";
const TOKEN_B = "agentport-g4-principal-b";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the G4 daemon child`);
  }
  return value;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function structured(result: {
  structuredContent?: unknown;
}): Record<string, unknown> {
  assert(
    typeof result.structuredContent === "object" &&
      result.structuredContent !== null,
    "Expected structuredContent",
  );
  return result.structuredContent as Record<string, unknown>;
}

function task(result: {
  structuredContent?: unknown;
}): Record<string, unknown> {
  const payload = structured(result);
  assert(payload.ok === true, "Expected an ok Task payload");
  assert(typeof payload.task === "object", "Expected a Task in the payload");
  return payload.task as Record<string, unknown>;
}

function connectClient(url: URL, token: string): Client {
  const client = new Client(
    { name: "g4-daemon-child", version: "1.0.0" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
    },
  );
  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: { token: () => Promise.resolve(token) },
  });
  return Object.assign(client, { g4Transport: transport });
}

async function connect(url: URL, token: string): Promise<Client> {
  const client = connectClient(url, token) as Client & {
    g4Transport: StreamableHTTPClientTransport;
  };
  await client.connect(client.g4Transport);
  return client;
}

async function waitForTask(
  client: Client,
  taskId: string,
  predicate: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 180_000;
  while (Date.now() <= deadline) {
    const current = task(
      await client.callTool({
        name: "agentport_get_task",
        arguments: { taskId },
      }),
    );
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for a bounded G4 Task state");
}

function firstAnswer(
  question: Record<string, unknown>,
): Record<string, string> {
  assert(Array.isArray(question.schema), "G4 Question schema is unavailable");
  const answer: Record<string, string> = {};
  for (const item of question.schema as unknown[]) {
    assert(
      typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        typeof (item as Record<string, unknown>).question === "string" &&
        Array.isArray((item as Record<string, unknown>).options),
      "G4 Question schema is invalid",
    );
    const options = (item as Record<string, unknown>).options as unknown[];
    const option = options[0];
    assert(
      typeof option === "object" &&
        option !== null &&
        !Array.isArray(option) &&
        typeof (option as Record<string, unknown>).label === "string",
      "G4 Question option is invalid",
    );
    answer[(item as Record<string, unknown>).question as string] = (
      option as { label: string }
    ).label;
  }
  return answer;
}

async function main(): Promise<void> {
  const states: string[] = [];
  const ingressDirectory = requiredEnvironment(
    "AGENTPORT_G1_INGRESS_DIRECTORY",
  );
  const databasePath = requiredEnvironment("AGENTPORT_G1_DATABASE_PATH");
  const workspacePath = requiredEnvironment("AGENTPORT_G1_WORKSPACE_PATH");
  const socketPath = requiredEnvironment("AGENTPORT_G1_LAUNCHER_SOCKET");
  const socketGroupId = (await lstat(socketPath)).gid;
  const runtimeGroupId = Number(
    requiredEnvironment("AGENTPORT_G1_RUNTIME_GID"),
  );
  const ingressGroupId = Number(
    requiredEnvironment("AGENTPORT_G1_INGRESS_GID"),
  );

  let composition:
    Awaited<ReturnType<typeof createControlledRuntimeAdmission>> | undefined;
  let server:
    Awaited<ReturnType<typeof startLoopbackDurableAdmissionServer>> | undefined;
  let clientA: Client | undefined;
  let clientB: Client | undefined;
  try {
    composition = await createControlledRuntimeAdmission({
      registry: {
        credentials: { [TOKEN_A]: "principal-a", [TOKEN_B]: "principal-b" },
        principals: [
          {
            principalId: "principal-a",
            accessScopeId: "g4-scope",
            active: true,
            allowedAgentIds: ["g4-agent"],
          },
          {
            principalId: "principal-b",
            accessScopeId: "g4-scope",
            active: true,
            allowedAgentIds: ["g4-agent"],
          },
        ],
        agents: [
          {
            agentId: "g4-agent",
            description: "Designated G4 Claude interaction fixture",
            workspacePath,
            configurationRevision: "g4-designated-v1",
            runtimeDriver: "claude-agent-sdk",
            runtimeVersion: "0.3.269",
            launchProfileId: PROFILE,
            policy: {
              maximumExecutionLimitSeconds: 3_600,
              maximumInputWaitSeconds: 86_400,
            },
          },
        ],
      },
      cursorSecret: randomBytes(32).toString("base64url"),
      storage: {
        databasePath,
        continuationEncryptionKey: randomBytes(32).toString("base64url"),
      },
      launcher: {
        socketPath,
        workerIngressDirectory: ingressDirectory,
        socketGroupId,
        runtimeGroupId,
        ingressGroupId,
      },
    });
    let auditRecordCount = 0;
    server = await startLoopbackDurableAdmissionServer({
      registry: composition.registry,
      handler: composition.mcpHandler,
      auditRecorder: {
        recordAudit() {
          auditRecordCount += 1;
          return Promise.resolve();
        },
        flushAudit() {
          return Promise.resolve();
        },
      },
    });
    clientA = await connect(server.url, TOKEN_A);
    clientB = await connect(server.url, TOKEN_B);
    const initial = task(
      await clientA.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: `g4-submit-${randomUUID()}`,
          agentId: "g4-agent",
          instruction: "Run the designated G4 native Question fixture.",
        },
      }),
    );
    const initialTaskId = String(initial.taskId);
    const started = await composition.dispatch(initialTaskId);
    assert(started.kind === "started", "Initial G4 Task did not start");
    const awaiting = await waitForTask(
      clientB,
      initialTaskId,
      (value) => value.state === "awaiting_input",
    );
    states.push("question_pending");
    const question = awaiting.question;
    assert(
      typeof question === "object" &&
        question !== null &&
        !Array.isArray(question),
      "G4 native Question was not published",
    );
    const replied = task(
      await clientB.callTool({
        name: "agentport_reply",
        arguments: {
          operationId: `g4-reply-${randomUUID()}`,
          taskId: initialTaskId,
          questionId: String((question as Record<string, unknown>).questionId),
          answer: firstAnswer(question as Record<string, unknown>),
        },
      }),
    );
    assert(
      replied.taskId === initialTaskId &&
        replied.state === "awaiting_input" &&
        typeof replied.question === "object" &&
        replied.question !== null &&
        (replied.question as Record<string, unknown>).state === "accepted" &&
        (replied.question as Record<string, unknown>).delivery === "pending",
      "G4 reply was not accepted with pending delivery",
    );
    states.push("answer_accepted_delivery_pending");
    await waitForTask(
      clientA,
      initialTaskId,
      (value) =>
        value.state === "completed" &&
        (value.result as Record<string, unknown> | null)?.summary ===
          "AGENTPORT_G4_QUESTION_OK",
    );
    states.push("question_task_completed");

    const canceled = task(
      await clientA.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: `g4-canceled-submit-${randomUUID()}`,
          agentId: "g4-agent",
          contextId: initial.contextId,
          instruction: "Create the removable continuation blocker.",
        },
      }),
    );
    const canceledTaskId = String(canceled.taskId);
    const canceledStarted = await composition.dispatch(canceledTaskId);
    assert(canceledStarted.kind === "started", "Blocker G4 Task did not start");
    await waitForTask(
      clientA,
      canceledTaskId,
      (value) => value.state === "awaiting_input",
    );
    states.push("blocker_question_pending");
    await clientA.callTool({
      name: "agentport_cancel_task",
      arguments: {
        operationId: `g4-cancel-${randomUUID()}`,
        taskId: canceledTaskId,
      },
    });
    await waitForTask(
      clientA,
      canceledTaskId,
      (value) => value.state === "canceled",
    );
    states.push("blocker_canceled");

    const successor = task(
      await clientA.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: `g4-successor-submit-${randomUUID()}`,
          agentId: "g4-agent",
          contextId: initial.contextId,
          instruction: "Continue explicitly in a fresh Session.",
        },
      }),
    );
    assert(
      successor.state === "paused" &&
        typeof successor.blocker === "object" &&
        successor.blocker !== null &&
        (successor.blocker as Record<string, unknown>).predecessorTaskId ===
          canceledTaskId &&
        (successor.blocker as Record<string, unknown>).state === "canceled",
      "Successor G4 Task was not paused on the canceled blocker",
    );
    states.push("successor_paused");
    const successorTaskId = String(successor.taskId);
    const resumed = task(
      await clientB.callTool({
        name: "agentport_resume_context",
        arguments: {
          operationId: `g4-resume-${randomUUID()}`,
          contextId: initial.contextId,
          expectedRevision: successor.contextRevision,
          continuationMode: "fresh_session",
          contextSummary:
            "The prior native Question was answered; continue the accepted queue without native continuity.",
        },
      }),
    );
    assert(
      resumed.taskId === successorTaskId &&
        resumed.queueOrder === successor.queueOrder &&
        resumed.state === "queued" &&
        typeof resumed.continuation === "object" &&
        resumed.continuation !== null &&
        (resumed.continuation as Record<string, unknown>).mode ===
          "fresh_session" &&
        (resumed.continuation as Record<string, unknown>).nativeContinuity ===
          "abandoned",
      "Fresh continuation was not queued as expected",
    );
    states.push("fresh_continuation_queued");
    const resumedStarted = await composition.dispatch(successorTaskId);
    assert(
      resumedStarted.kind === "started",
      "Fresh continuation G4 Task did not start",
    );
    await waitForTask(
      clientA,
      successorTaskId,
      (value) =>
        value.state === "completed" &&
        (value.result as Record<string, unknown> | null)?.summary ===
          "AGENTPORT_G4_CONTINUATION_OK",
    );
    states.push("fresh_continuation_completed");
    assert(auditRecordCount > 0, "No audit records were recorded");
    process.stdout.write(
      `${JSON.stringify({
        outcome: "OK",
        processUid: process.getuid?.() ?? -1,
        states,
      })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        outcome: "FAILED",
        processUid: process.getuid?.() ?? -1,
        states,
      })}\n`,
    );
    throw error;
  } finally {
    await Promise.allSettled([clientB?.close(), clientA?.close()]);
    await server?.close();
    await composition?.close();
  }
}

main().catch(() => {
  process.exitCode = 1;
});
