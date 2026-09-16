import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";

import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import {
  createDurableAdmissionFixture,
  SCOPE_A_TOKEN,
} from "./fixtures/durable-admission.js";
import {
  connectDurableAdmissionClient,
  startDurableAdmissionMcpEndpoint,
} from "./fixtures/durable-admission-mcp.js";

const RESULT_DIRECTORY = "node_modules/.cache/agentport-ap015";
const TARGET_MS = 2_000;
const REPLAYS_PER_CONTROL = 12;
const CONTROL_NAMES = ["reply", "cancel", "acknowledgement"] as const;
type ControlName = (typeof CONTROL_NAMES)[number];
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
type Timing = {
  freshMs: number[];
  replayMs: number[];
  unavailable: number;
  failure: number;
};

function payload(result: ToolResult): Record<string, unknown> {
  if (
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null ||
    Array.isArray(result.structuredContent)
  )
    throw new Error("Expected structured MCP result");
  return result.structuredContent as Record<string, unknown>;
}

function percentile(
  sorted: readonly number[],
  fraction: number,
): number | null {
  return sorted.length === 0
    ? null
    : (sorted[Math.ceil(sorted.length * fraction) - 1] ?? null);
}

function distribution(timing: Timing) {
  const successful = [...timing.freshMs, ...timing.replayMs].sort(
    (left, right) => left - right,
  );
  return {
    freshSuccesses: timing.freshMs.length,
    replaySuccesses: timing.replayMs.length,
    normallySuccessfulSamples: successful.length,
    unavailable: timing.unavailable,
    failure: timing.failure,
    maxMs: successful.at(-1) ?? null,
    p50Ms: percentile(successful, 0.5),
    p95Ms: percentile(successful, 0.95),
    p99Ms: percentile(successful, 0.99),
    meetsTwoSecondTarget:
      timing.freshMs.length === 1 &&
      timing.replayMs.length === REPLAYS_PER_CONTROL &&
      timing.unavailable === 0 &&
      timing.failure === 0 &&
      successful.every((elapsed) => elapsed <= TARGET_MS),
  };
}

async function candidateDigest(): Promise<string> {
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
  });
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  );
  const digest = createHash("sha256");
  for (const path of [...tracked.split("\0"), ...untracked.split("\0")]
    .filter(Boolean)
    .sort()) {
    digest.update(path);
    digest.update("\0");
    try {
      digest.update(await readFile(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      digest.update("<deleted>");
    }
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function packageVersions(): Promise<Record<string, string>> {
  const manifest: unknown = JSON.parse(await readFile("package.json", "utf8"));
  if (typeof manifest !== "object" || manifest === null)
    throw new Error("package.json is not an object");
  const dependencies = (manifest as { dependencies?: unknown }).dependencies;
  if (typeof dependencies !== "object" || dependencies === null)
    throw new Error("package.json dependencies are missing");
  const required = [
    "@modelcontextprotocol/client",
    "@modelcontextprotocol/server",
    "better-sqlite3",
  ] as const;
  return Object.fromEntries(
    required.map((name) => {
      const version = (dependencies as Record<string, unknown>)[name];
      if (typeof version !== "string")
        throw new Error(`Missing package version for ${name}`);
      return [name, version];
    }),
  );
}

async function measured(
  timing: Timing,
  replay: boolean,
  call: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const started = performance.now();
  try {
    const result = await call();
    const response = payload(result);
    const elapsed = performance.now() - started;
    if (result.isError === true || response.ok !== true) {
      const code = (response.error as Record<string, unknown> | undefined)
        ?.code;
      if (code === "storage_unavailable") timing.unavailable += 1;
      else timing.failure += 1;
    } else if (replay) timing.replayMs.push(elapsed);
    else timing.freshMs.push(elapsed);
    return result;
  } catch {
    timing.failure += 1;
    throw new Error("Official MCP Client call failed");
  }
}

function accepted(result: ToolResult): Record<string, unknown> {
  const value = payload(result);
  expect(result.isError).not.toBe(true);
  expect(value.ok).toBe(true);
  return value;
}

function projectedTaskState(task: unknown) {
  const value = task as Record<string, unknown>;
  const execution = value.execution as Record<string, unknown> | undefined;
  const question = value.question as Record<string, unknown> | undefined;
  return {
    state: value.state ?? null,
    executionState: execution?.state ?? null,
    questionState: question?.state ?? null,
    questionDelivery: question?.delivery ?? null,
  };
}

describe("AP-015 candidate-bound existing-Task control measurement", () => {
  it("records full official-Client control timing and durable invariants under synthetic pressure", async () => {
    const before = await candidateDigest();
    const fixture = await createDurableAdmissionFixture({
      receiptCapacity: 5,
      auditCapacity: 1,
    });
    const endpoint = await startDurableAdmissionMcpEndpoint(fixture);
    const clients: Client[] = [];
    const timing: Record<ControlName, Timing> = {
      reply: { freshMs: [], replayMs: [], unavailable: 0, failure: 0 },
      cancel: { freshMs: [], replayMs: [], unavailable: 0, failure: 0 },
      acknowledgement: {
        freshMs: [],
        replayMs: [],
        unavailable: 0,
        failure: 0,
      },
    };
    let recordLocation: string | undefined;
    try {
      const agentA = fixture.registryConfiguration.agents.find(
        ({ agentId }) => agentId === "agent-a",
      );
      if (agentA === undefined) throw new Error("Fixture Agent is missing");
      await Promise.all([
        mkdir(`${fixture.directory}/workspace-c`),
        mkdir(`${fixture.directory}/workspace-d`),
      ]);
      await fixture.registry.replace({
        ...fixture.registryConfiguration,
        agents: [
          ...fixture.registryConfiguration.agents,
          {
            ...agentA,
            agentId: "agent-c",
            workspacePath: `${fixture.directory}/workspace-c`,
          },
          {
            ...agentA,
            agentId: "agent-d",
            workspacePath: `${fixture.directory}/workspace-d`,
          },
        ],
        principals: fixture.registryConfiguration.principals.map((principal) =>
          principal.principalId === "principal-a"
            ? {
                ...principal,
                allowedAgentIds: [
                  ...principal.allowedAgentIds,
                  "agent-c",
                  "agent-d",
                ],
              }
            : principal,
        ),
      });
      for (let index = 0; index < 3; index++)
        clients.push(
          await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
        );
      const [replyClient, cancelClient, acknowledgementClient] = clients;
      if (!replyClient || !cancelClient || !acknowledgementClient)
        throw new Error("Missing official MCP Client");

      const tasks: Array<{
        taskId: string;
        contextId: string;
        reference: unknown;
      }> = [];
      for (const [index, agentId] of [
        "agent-a",
        "agent-revokable",
        "agent-c",
        "agent-d",
      ].entries()) {
        const submitted = accepted(
          await replyClient.callTool({
            name: "agentport_submit_task",
            arguments: {
              operationId: `ap015-measure-submit-${String(index)}`,
              agentId,
              instruction: "synthetic control load",
            },
          }),
        ).task as Record<string, unknown>;
        const taskId = String(submitted.taskId);
        const contextId = String(submitted.contextId);
        const prepared = await fixture.service.prepareForDispatch(
          taskId,
          `ap015-measure-held-reference-${String(index)}`,
        );
        await fixture.service.markExecutionRunning(prepared.reference);
        tasks.push({ taskId, contextId, reference: prepared.reference });
      }
      const [replyTarget, cancelTarget, acknowledgementTarget] = tasks;
      if (!replyTarget || !cancelTarget || !acknowledgementTarget)
        throw new Error("Missing synthetic held control targets");
      const queuedSuccessor = accepted(
        await replyClient.callTool({
          name: "agentport_submit_task",
          arguments: {
            operationId: "ap015-measure-fifo-successor",
            agentId: "agent-a",
            contextId: replyTarget.contextId,
            instruction: "synthetic same-Workspace FIFO successor",
          },
        }),
      ).task as Record<string, unknown>;
      const queuedSuccessorId = String(queuedSuccessor.taskId);
      const initialQueuedSuccessor = await fixture.service.getTask(
        { principalId: "principal-a" },
        { taskId: queuedSuccessorId },
      );
      expect(initialQueuedSuccessor).toMatchObject({
        state: "queued",
        predecessorTaskId: replyTarget.taskId,
      });
      await fixture.store.persistQuestionObservation({
        reference: replyTarget.reference as Parameters<
          typeof fixture.store.persistQuestionObservation
        >[0]["reference"],
        questionId: "ap015-measure-question",
        toolUseId: "ap015-measure-tool",
        requestId: "ap015-measure-request",
        ordinal: 1,
        toolActivity: "none",
        activeElapsedMs: 0,
        schema: [
          {
            question: "Continue",
            header: "Control",
            options: [
              { label: "Continue", description: "Continue" },
              { label: "Pause", description: "Pause" },
            ],
            multiSelect: false,
          },
        ],
        expiresAt: "2026-09-15T00:00:00.000Z",
        now: "2026-09-14T00:00:00.000Z",
      });

      const saturated = await replyClient.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap015-measure-saturated-admission",
          agentId: "agent-a",
          instruction: "must remain rejected",
        },
      });
      expect(payload(saturated)).toMatchObject({
        ok: false,
        error: { code: "tombstone_capacity" },
      });

      const replyInput = {
        operationId: "ap015-measure-reply",
        taskId: replyTarget.taskId,
        questionId: "ap015-measure-question",
        answer: { Continue: "Continue" },
      };
      const cancelInput = {
        operationId: "ap015-measure-cancel",
        taskId: cancelTarget.taskId,
      };
      const poll = () =>
        Promise.all([
          replyClient.callTool({
            name: "agentport_get_task",
            arguments: { taskId: replyTarget.taskId },
          }),
          cancelClient.callTool({
            name: "agentport_get_events",
            arguments: { taskId: cancelTarget.taskId, limit: 1 },
          }),
          acknowledgementClient.callTool({
            name: "agentport_list_tasks",
            arguments: { agentId: "agent-a", limit: 1 },
          }),
          endpoint.flushAudit(),
        ]);
      const replyFirst = await Promise.all([
        measured(timing.reply, false, () =>
          replyClient.callTool({
            name: "agentport_reply",
            arguments: replyInput,
          }),
        ),
        poll(),
      ]);
      expect(accepted(replyFirst[0])).toMatchObject({
        replayed: false,
        task: { question: { state: "accepted", delivery: "pending" } },
      });
      for (let index = 0; index < REPLAYS_PER_CONTROL; index++)
        expect(
          accepted(
            await measured(timing.reply, true, () =>
              replyClient.callTool({
                name: "agentport_reply",
                arguments: replyInput,
              }),
            ),
          ),
        ).toMatchObject({ replayed: true });

      const cancelFirst = await Promise.all([
        measured(timing.cancel, false, () =>
          cancelClient.callTool({
            name: "agentport_cancel_task",
            arguments: cancelInput,
          }),
        ),
        poll(),
      ]);
      expect(accepted(cancelFirst[0])).toMatchObject({
        replayed: false,
        task: { state: "stopping", execution: { state: "stopping" } },
      });
      for (let index = 0; index < REPLAYS_PER_CONTROL; index++)
        expect(
          accepted(
            await measured(timing.cancel, true, () =>
              cancelClient.callTool({
                name: "agentport_cancel_task",
                arguments: cancelInput,
              }),
            ),
          ),
        ).toMatchObject({ replayed: true, task: { state: "stopping" } });
      const allowedAgentIds = [
        "agent-a",
        "agent-revokable",
        "agent-c",
        "agent-d",
      ];
      const cancelExecutionDuringStopping = await fixture.store.getExecution({
        accessScopeId: "scope-a",
        allowedAgentIds,
        taskId: cancelTarget.taskId,
      });
      if (cancelExecutionDuringStopping === undefined)
        throw new Error("Cancel execution is missing during stopping");
      expect(cancelExecutionDuringStopping).toMatchObject({
        workspaceClaim: "held",
      });
      const [replyProjectionBeforeRecovery, successorProjectionBeforeRecovery] =
        await Promise.all([
          fixture.service.getTask(
            { principalId: "principal-a" },
            { taskId: replyTarget.taskId },
          ),
          fixture.service.getTask(
            { principalId: "principal-a" },
            { taskId: queuedSuccessorId },
          ),
        ]);
      expect(projectedTaskState(replyProjectionBeforeRecovery)).toMatchObject({
        questionState: "accepted",
        questionDelivery: "pending",
      });
      expect(
        projectedTaskState(successorProjectionBeforeRecovery),
      ).toMatchObject({
        state: "queued",
      });

      await fixture.store.recoverExecutions();
      const recovering = await fixture.service.getTask(
        { principalId: "principal-a" },
        { taskId: acknowledgementTarget.taskId },
      );
      const acknowledgementInput = {
        operationId: "ap015-measure-acknowledgement",
        taskId: acknowledgementTarget.taskId,
        expectedRevision: recovering.revision,
      };
      const premature = await acknowledgementClient.callTool({
        name: "agentport_acknowledge_interruption",
        arguments: acknowledgementInput,
      });
      expect(payload(premature)).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
      // This is a scripted, platform-neutral store precondition for the existing
      // schema branch. It does not represent a Runtime start or trusted Stop Evidence.
      await fixture.store.confirmRecoveryStopped({
        evidence: {
          platform: "linux-cgroup-v2",
          reference: acknowledgementTarget.reference as Parameters<
            typeof fixture.store.confirmRecoveryStopped
          >[0]["evidence"]["reference"],
          executionUnitId: "ap015-scripted-stopped-precondition",
          generationSealedAt: "2026-09-15T00:00:01.000Z",
          unitEmptyObservedAt: "2026-09-15T00:00:02.000Z",
        },
        now: "2026-09-15T00:00:03.000Z",
      });
      const acknowledgementFirst = await Promise.all([
        measured(timing.acknowledgement, false, () =>
          acknowledgementClient.callTool({
            name: "agentport_acknowledge_interruption",
            arguments: acknowledgementInput,
          }),
        ),
        poll(),
      ]);
      expect(accepted(acknowledgementFirst[0])).toMatchObject({
        replayed: false,
        task: { state: "interrupted", execution: { state: "interrupted" } },
      });
      for (let index = 0; index < REPLAYS_PER_CONTROL; index++)
        expect(
          accepted(
            await measured(timing.acknowledgement, true, () =>
              acknowledgementClient.callTool({
                name: "agentport_acknowledge_interruption",
                arguments: acknowledgementInput,
              }),
            ),
          ),
        ).toMatchObject({ replayed: true, task: { state: "interrupted" } });

      const acknowledgementExecutionAfterScriptedPrecondition =
        await fixture.store.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds,
          taskId: acknowledgementTarget.taskId,
        });
      if (acknowledgementExecutionAfterScriptedPrecondition === undefined)
        throw new Error(
          "Acknowledgement execution is missing after precondition",
        );
      expect(acknowledgementExecutionAfterScriptedPrecondition).toMatchObject({
        workspaceClaim: "released",
      });
      const [
        replyProjection,
        cancelProjection,
        acknowledgementProjection,
        successorProjection,
      ] = await Promise.all([
        fixture.service.getTask(
          { principalId: "principal-a" },
          { taskId: replyTarget.taskId },
        ),
        fixture.service.getTask(
          { principalId: "principal-a" },
          { taskId: cancelTarget.taskId },
        ),
        fixture.service.getTask(
          { principalId: "principal-a" },
          { taskId: acknowledgementTarget.taskId },
        ),
        fixture.service.getTask(
          { principalId: "principal-a" },
          { taskId: queuedSuccessorId },
        ),
      ]);
      const durability = await fixture.store.probe("inspectDurability");
      const receiptCount = (durability as Record<string, unknown>).receipts;
      const durableActual = {
        receipts: receiptCount,
        replayReceiptGrowth:
          typeof receiptCount === "number" ? receiptCount - 8 : null,
        tasks: {
          reply: {
            beforeRecovery: projectedTaskState(replyProjectionBeforeRecovery),
            afterRecovery: projectedTaskState(replyProjection),
          },
          cancel: projectedTaskState(cancelProjection),
          acknowledgement: projectedTaskState(acknowledgementProjection),
          queuedSuccessor: {
            beforeRecovery: projectedTaskState(
              successorProjectionBeforeRecovery,
            ),
            afterRecovery: projectedTaskState(successorProjection),
          },
        },
        claims: {
          cancelDuringStopping: cancelExecutionDuringStopping.workspaceClaim,
          acknowledgementAfterScriptedPrecondition:
            acknowledgementExecutionAfterScriptedPrecondition.workspaceClaim,
        },
        starts: {
          syntheticHeldReferences: tasks.length,
          actualRuntimeStarts: 0,
          trustedStopEvidence: 0,
        },
      };
      const durableInvariantPass =
        receiptCount === 8 &&
        durableActual.replayReceiptGrowth === 0 &&
        durableActual.tasks.reply.beforeRecovery.questionState === "accepted" &&
        durableActual.tasks.reply.beforeRecovery.questionDelivery ===
          "pending" &&
        durableActual.tasks.cancel.state === "recovering" &&
        durableActual.tasks.acknowledgement.state === "interrupted" &&
        durableActual.tasks.queuedSuccessor.beforeRecovery.state === "queued" &&
        durableActual.claims.cancelDuringStopping === "held" &&
        durableActual.claims.acknowledgementAfterScriptedPrecondition ===
          "released";
      const dependencyVersions = await packageVersions();
      const after = await candidateDigest();
      const tools = Object.fromEntries(
        CONTROL_NAMES.map((name) => [name, distribution(timing[name])]),
      ) as Record<ControlName, ReturnType<typeof distribution>>;
      const durable = {
        expected: {
          submittedReceipts: 5,
          controlReceipts: 3,
          totalReceiptsWithoutReplayGrowth: 8,
          reply: {
            questionStateBeforeRecovery: "accepted",
            questionDeliveryBeforeRecovery: "pending",
          },
          cancel: {
            stateAfterRecovery: "recovering",
            claimDuringStopping: "held",
          },
          acknowledgement: {
            state: "interrupted",
            claimAfterScriptedPrecondition: "released",
          },
          queuedSuccessor: { count: 1, stateBeforeRecovery: "queued" },
        },
        actual: durableActual,
      };
      const passed =
        before === after &&
        durableInvariantPass &&
        Object.values(tools).every(
          ({ meetsTwoSecondTarget }) => meetsTwoSecondTarget,
        );
      const recordedAt = new Date().toISOString();
      recordLocation = `${RESULT_DIRECTORY}/result-${before.slice(0, 16)}-${recordedAt.replace(/[:.]/g, "-")}.json`;
      const record = {
        story: "AP-015",
        resultLocation: recordLocation,
        recordedAt,
        method:
          "performance.now() from official MCP Client callTool invocation to full result resolution",
        candidate: {
          baseRevision: execFileSync("git", ["rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
          sourceSha256Before: before,
          sourceSha256After: after,
        },
        platform: {
          os: platform(),
          release: release(),
          arch: arch(),
          cpuModel: cpus()[0]?.model ?? "unknown",
          logicalCpus: cpus().length,
          totalMemoryBytes: totalmem(),
          node: process.version,
          pnpm: execFileSync("pnpm", ["--version"], {
            encoding: "utf8",
          }).trim(),
          mcpClient: dependencyVersions["@modelcontextprotocol/client"],
          mcpServer: dependencyVersions["@modelcontextprotocol/server"],
          betterSqlite3: dependencyVersions["better-sqlite3"],
        },
        fixture: {
          realSqliteWorker: true,
          loopbackOfficialClients: clients.length,
          configuredGeneralReceiptCapacity: 5,
          configuredAuditCapacity: 1,
          heldSyntheticReferences: 4,
          queuedSameWorkspaceFifoSuccessors: 1,
          actualRuntimeStarts: 0,
          staticPollingCallsPerControl: 3,
          boundedEventPageLimit: 1,
          auditFlushesDuringPressure: 3,
          freshSamplesPerControl: 1,
          replaySamplesPerControl: REPLAYS_PER_CONTROL,
          heldCallbackDuringTimedRounds: false,
          heldIngressDuringTimedRounds: false,
          scriptedStoppedPrecondition:
            "existing SQLite schema branch only; not trusted Stop Evidence",
        },
        targetMs: TARGET_MS,
        percentileMethod:
          "nearest rank among normally successful fresh and identical-operation replay full responses",
        tools,
        durable,
        expected:
          "candidate is stable; all three controls have one fresh and twelve replayed normal successes at or below 2000 ms; unavailable and failed outcomes remain separate",
        actual: passed ? "PASS" : "FAIL",
        limitations: [
          "Synthetic held References are not Runtime starts.",
          "The scripted stopped precondition is not Linux Stop Evidence, Supervisor proof, or production claim-release evidence.",
          "This does not establish Client-outage handling, production backpressure, G5, S6, host/network availability, or production latency.",
          "Fixture response timing is synthetic-local evidence, not production timing evidence.",
          "Timed rounds do not hold a worker callback or ingress; AP-015's deterministic cancellation fixture covers that separate condition.",
        ],
      };
      const sanitizedRecord = JSON.stringify(record);
      for (const task of tasks) {
        const reference = task.reference as {
          generation: string;
          daemonEpoch: string;
        };
        expect(sanitizedRecord).not.toContain(reference.generation);
        expect(sanitizedRecord).not.toContain(reference.daemonEpoch);
      }
      await mkdir(RESULT_DIRECTORY, { recursive: true });
      await writeFile(recordLocation, `${JSON.stringify(record, null, 2)}\n`);
      console.log(`AP-015 sanitized control record: ${recordLocation}`);
      expect(before, "candidate source changed while measured").toBe(after);
      expect(
        durableInvariantPass,
        "AP-015 durable control invariants missed",
      ).toBe(true);
      expect(passed, "AP-015 control timing or invariant target missed").toBe(
        true,
      );
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await endpoint.close();
      await fixture.close();
      if (recordLocation !== undefined)
        console.log(`AP-015 result location: ${recordLocation}`);
    }
  });
});
