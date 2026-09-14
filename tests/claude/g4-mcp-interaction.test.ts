import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, chown, mkdtemp, rm, stat } from "node:fs/promises";
import { release } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createControlledRuntimeAdmission } from "../../src/bootstrap/create-controlled-runtime-admission.js";
import { startLoopbackDurableAdmissionServer } from "../../src/mcp/loopback-server.js";
import { connectDurableAdmissionClient } from "../fixtures/durable-admission-mcp.js";
import { requiredEnvironment } from "../fixtures/linux-supervisor.js";

const G4_ENABLED =
  process.platform === "linux" &&
  process.env["AGENTPORT_G1_LINUX"] === "1" &&
  process.env["AGENTPORT_G1_CLAUDE"] === "1";
const PROFILE = "g4-claude-interaction";
const TOKEN_A = "agentport-g4-principal-a";
const TOKEN_B = "agentport-g4-principal-b";

function structured(result: {
  structuredContent?: unknown;
}): Record<string, unknown> {
  expect(result.structuredContent).toBeTypeOf("object");
  return result.structuredContent as Record<string, unknown>;
}

function task(result: {
  structuredContent?: unknown;
}): Record<string, unknown> {
  const payload = structured(result);
  expect(payload.ok).toBe(true);
  expect(payload.task).toBeTypeOf("object");
  return payload.task as Record<string, unknown>;
}

async function waitForTask(
  client: Awaited<ReturnType<typeof connectDurableAdmissionClient>>,
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
  if (!Array.isArray(question.schema)) {
    throw new Error("G4 Question schema is unavailable");
  }
  const answer: Record<string, string> = {};
  for (const item of question.schema) {
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      typeof (item as Record<string, unknown>).question !== "string" ||
      !Array.isArray((item as Record<string, unknown>).options)
    ) {
      throw new Error("G4 Question schema is invalid");
    }
    const options = (item as Record<string, unknown>).options as unknown[];
    const option = options[0];
    if (
      typeof option !== "object" ||
      option === null ||
      Array.isArray(option) ||
      typeof (option as Record<string, unknown>).label !== "string"
    ) {
      throw new Error("G4 Question option is invalid");
    }
    answer[(item as Record<string, unknown>).question as string] = (
      option as { label: string }
    ).label;
  }
  return answer;
}

function evidence(outcome: "OK" | "FAILED", states: readonly string[]): string {
  const candidates = [
    "AGENTPORT_G4_QUESTION_OK",
    "AGENTPORT_G4_CONTINUATION_OK",
  ];
  return `G4_CLAUDE_INTERACTION_${outcome} ${JSON.stringify({
    platform: process.platform,
    kernel: release(),
    node: process.version,
    profile: PROFILE,
    candidateDigest: createHash("sha256")
      .update(JSON.stringify(candidates))
      .digest("hex"),
    states,
  })}\n`;
}

describe.skipIf(!G4_ENABLED)("real Claude interaction through MCP", () => {
  it("answers a native Question from a second same-scope Principal and explicitly continues the original queue in a fresh Session", async () => {
    const states: string[] = [];
    const coreDataPath = requiredEnvironment("AGENTPORT_G1_CORE_DATA_PATH");
    const workspacePath = requiredEnvironment("AGENTPORT_G1_WORKSPACE_PATH");
    const runtimeGroupId = Number(
      requiredEnvironment("AGENTPORT_G1_RUNTIME_GID"),
    );
    await stat(workspacePath);
    const directory = await mkdtemp(join(coreDataPath, "g4-interaction-"));
    await chown(directory, 0, runtimeGroupId);
    await chmod(directory, 0o750);
    let composition:
      Awaited<ReturnType<typeof createControlledRuntimeAdmission>> | undefined;
    let server:
      | Awaited<ReturnType<typeof startLoopbackDurableAdmissionServer>>
      | undefined;
    let clientA:
      Awaited<ReturnType<typeof connectDurableAdmissionClient>> | undefined;
    let clientB:
      Awaited<ReturnType<typeof connectDurableAdmissionClient>> | undefined;
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
          databasePath: join(directory, "agentport-g4.sqlite"),
          continuationEncryptionKey: randomBytes(32).toString("base64url"),
        },
        launcher: {
          socketPath: requiredEnvironment("AGENTPORT_G1_LAUNCHER_SOCKET"),
          workerIngressDirectory: directory,
          runtimeGroupId,
        },
      });
      const auditRecords: unknown[] = [];
      server = await startLoopbackDurableAdmissionServer({
        registry: composition.registry,
        handler: composition.mcpHandler,
        auditRecorder: {
          recordAudit(record) {
            auditRecords.push(record);
            return Promise.resolve();
          },
          flushAudit() {
            return Promise.resolve();
          },
        },
      });
      clientA = await connectDurableAdmissionClient(server.url, TOKEN_A);
      clientB = await connectDurableAdmissionClient(server.url, TOKEN_B);
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
      await expect(composition.dispatch(initialTaskId)).resolves.toEqual({
        kind: "started",
      });
      const awaiting = await waitForTask(
        clientB,
        initialTaskId,
        (value) => value.state === "awaiting_input",
      );
      states.push("question_pending");
      const question = awaiting.question;
      if (
        typeof question !== "object" ||
        question === null ||
        Array.isArray(question)
      ) {
        throw new Error("G4 native Question was not published");
      }
      const replied = task(
        await clientB.callTool({
          name: "agentport_reply",
          arguments: {
            operationId: `g4-reply-${randomUUID()}`,
            taskId: initialTaskId,
            questionId: String(
              (question as Record<string, unknown>).questionId,
            ),
            answer: firstAnswer(question as Record<string, unknown>),
          },
        }),
      );
      expect(replied).toMatchObject({
        taskId: initialTaskId,
        state: "awaiting_input",
        question: { state: "accepted", delivery: "pending" },
      });
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
      await expect(composition.dispatch(canceledTaskId)).resolves.toEqual({
        kind: "started",
      });
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
      expect(successor).toMatchObject({
        state: "paused",
        blocker: {
          predecessorTaskId: canceledTaskId,
          state: "canceled",
        },
      });
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
      expect(resumed).toMatchObject({
        taskId: successorTaskId,
        queueOrder: successor.queueOrder,
        state: "queued",
        continuation: {
          mode: "fresh_session",
          nativeContinuity: "abandoned",
        },
      });
      states.push("fresh_continuation_queued");
      await expect(composition.dispatch(successorTaskId)).resolves.toEqual({
        kind: "started",
      });
      await waitForTask(
        clientA,
        successorTaskId,
        (value) =>
          value.state === "completed" &&
          (value.result as Record<string, unknown> | null)?.summary ===
            "AGENTPORT_G4_CONTINUATION_OK",
      );
      states.push("fresh_continuation_completed");
      expect(auditRecords.length).toBeGreaterThan(0);
      process.stdout.write(evidence("OK", states));
    } catch (error) {
      process.stdout.write(evidence("FAILED", states));
      throw error;
    } finally {
      await Promise.allSettled([clientB?.close(), clientA?.close()]);
      await server?.close();
      await composition?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 480_000);
});
