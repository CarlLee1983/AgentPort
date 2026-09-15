import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem, arch } from "node:os";
import { join } from "node:path";

import type { Client } from "@modelcontextprotocol/client";
import { describe, it } from "vitest";

import {
  createDurableAdmissionFixture,
  SCOPE_A_TOKEN,
} from "./fixtures/durable-admission.js";
import {
  connectDurableAdmissionClient,
  startDurableAdmissionMcpEndpoint,
} from "./fixtures/durable-admission-mcp.js";

const PRIVATE_MARKER = "AP014-PRIVATE-INSTRUCTION-MARKER";
const TARGET_MS = 2_000;
const ROUNDS = 50;
const RESULT_DIRECTORY = "node_modules/.cache/agentport-ap014";
const TOOL_NAMES = [
  "agentport_get_task",
  "agentport_list_tasks",
  "agentport_get_events",
] as const;
type ToolName = (typeof TOOL_NAMES)[number];
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
type Outcome = "current" | "stale" | "unavailable" | "failure";
type Samples = {
  currentMs: number[];
  stale: number;
  unavailable: number;
  failure: number;
};

function payload(result: ToolResult): Record<string, unknown> | undefined {
  const value = result.structuredContent;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function classify(
  tool: ToolName,
  result: ToolResult,
  sentinelTaskId: string,
): Outcome {
  if (
    tool !== "agentport_get_task" &&
    JSON.stringify(result).includes(PRIVATE_MARKER)
  )
    return "failure";
  const value = payload(result);
  if (result.isError === true || value?.ok !== true) {
    const code = (value?.error as Record<string, unknown> | undefined)?.code;
    return code === "observation_unavailable" ? "unavailable" : "failure";
  }
  if (tool === "agentport_get_task") {
    const task = value.task as Record<string, unknown> | undefined;
    if (task?.taskId !== sentinelTaskId) return "failure";
    return task.observationStatus === "current"
      ? "current"
      : task.observationStatus === "stale"
        ? "stale"
        : "failure";
  }
  if (tool === "agentport_list_tasks") {
    const tasks = value.tasks;
    return Array.isArray(tasks) &&
      tasks.length <= 50 &&
      tasks.some(
        (task) =>
          typeof task === "object" &&
          task !== null &&
          (task as Record<string, unknown>).taskId === sentinelTaskId,
      )
      ? "current"
      : "failure";
  }
  const events = value.events;
  return Array.isArray(events) &&
    events.length === 50 &&
    events.some(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as Record<string, unknown>).taskId === sentinelTaskId,
    )
    ? "current"
    : "failure";
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? NaN;
}

function distribution(samples: Samples) {
  const sorted = [...samples.currentMs].sort((a, b) => a - b);
  return {
    current: sorted.length,
    stale: samples.stale,
    unavailable: samples.unavailable,
    failure: samples.failure,
    maxMs: sorted.at(-1) ?? null,
    p50Ms: sorted.length ? percentile(sorted, 0.5) : null,
    p95Ms: sorted.length ? percentile(sorted, 0.95) : null,
    p99Ms: sorted.length ? percentile(sorted, 0.99) : null,
    meetsTwoSecondTarget:
      sorted.length >= ROUNDS &&
      sorted.every((elapsed) => elapsed <= TARGET_MS),
  };
}

async function candidateFingerprint(): Promise<string> {
  const paths = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const digest = createHash("sha256");
  for (const path of paths) {
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

describe("AP-014 candidate-bound outer MCP observation measurement", () => {
  it("records full-response current latency under normal synthetic load", async () => {
    const before = await candidateFingerprint();
    const fixture = await createDurableAdmissionFixture();
    const endpoint = await startDurableAdmissionMcpEndpoint(fixture);
    const clients: Client[] = [];
    const newSamples = (): Samples => ({
      currentMs: [],
      stale: 0,
      unavailable: 0,
      failure: 0,
    });
    const samples: Record<ToolName, Samples> = {
      agentport_get_task: newSamples(),
      agentport_list_tasks: newSamples(),
      agentport_get_events: newSamples(),
    };
    let setupComplete = false;
    try {
      const workspaceC = join(fixture.directory, "workspace-c");
      const workspaceD = join(fixture.directory, "workspace-d");
      await Promise.all([mkdir(workspaceC), mkdir(workspaceD)]);
      const agentA = fixture.registryConfiguration.agents.find(
        ({ agentId }) => agentId === "agent-a",
      );
      if (agentA === undefined) throw new Error("Missing fixture Agent");
      await fixture.registry.replace({
        ...fixture.registryConfiguration,
        agents: [
          ...fixture.registryConfiguration.agents,
          { ...agentA, agentId: "agent-c", workspacePath: workspaceC },
          { ...agentA, agentId: "agent-d", workspacePath: workspaceD },
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
      const actor = { principalId: "principal-a" };
      const loadAgentIds = ["agent-a", "agent-revokable", "agent-c", "agent-d"];
      const heldTaskIds: string[] = [];
      for (const [index, agentId] of loadAgentIds.entries()) {
        const accepted = await fixture.service.submitTask(actor, {
          operationId: `ap014-timing-held-${String(index)}`,
          agentId,
          instruction: PRIVATE_MARKER,
        });
        const taskId = accepted.task.taskId;
        const { reference } = await fixture.service.prepareForDispatch(
          taskId,
          `ap014-timing-scripted-${String(index)}`,
        );
        await fixture.service.markExecutionRunning(reference);
        heldTaskIds.push(taskId);
      }
      for (let index = 0; index < 50; index++) {
        await fixture.service.submitTask(actor, {
          operationId: `ap014-timing-page-${String(index)}`,
          agentId: loadAgentIds[index % loadAgentIds.length] ?? "agent-a",
          instruction: PRIVATE_MARKER,
        });
      }
      const sentinelTaskId = heldTaskIds[0];
      if (sentinelTaskId === undefined) throw new Error("Missing held Task");
      for (let index = 0; index < TOOL_NAMES.length; index++) {
        clients.push(
          await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
        );
      }
      setupComplete = true;
      for (let round = 0; round < ROUNDS; round++) {
        await Promise.all(
          TOOL_NAMES.map(async (tool, index) => {
            const client = clients[index];
            if (client === undefined)
              throw new Error("Missing official Client");
            const started = performance.now();
            try {
              const result = await client.callTool({
                name: tool,
                arguments:
                  tool === "agentport_get_task"
                    ? { taskId: sentinelTaskId }
                    : tool === "agentport_list_tasks"
                      ? { agentId: "agent-a", limit: 50 }
                      : { limit: 50 },
              });
              const elapsed = performance.now() - started;
              const outcome = classify(tool, result, sentinelTaskId);
              if (outcome === "current") samples[tool].currentMs.push(elapsed);
              else samples[tool][outcome] += 1;
            } catch {
              samples[tool].failure += 1;
            }
          }),
        );
      }
      const after = await candidateFingerprint();
      const observed = Object.fromEntries(
        TOOL_NAMES.map((tool) => [tool, distribution(samples[tool])]),
      ) as Record<ToolName, ReturnType<typeof distribution>>;
      const passed =
        before === after &&
        Object.values(observed).every(
          ({ meetsTwoSecondTarget }) => meetsTwoSecondTarget,
        );
      const recordedAt = new Date().toISOString();
      const resultLocation = `${RESULT_DIRECTORY}/result-${before.slice(0, 16)}-${recordedAt.replace(/[:.]/g, "-")}.json`;
      const record = {
        story: "AP-014",
        method: "official MCP Client callTool start to full result resolution",
        recordedAt,
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
        },
        fixture: {
          realSqliteWorker: true,
          loopbackOfficialClients: clients.length,
          heldSyntheticReferences: heldTaskIds.length,
          actualRuntimeStarts: 0,
          queuedPageTasks: 50,
          deliberateWorkerDelayMs: 0,
          heldIngressDuringTimedRounds: false,
          concurrentWritesDuringTimedRounds: 0,
          concurrentPollingCallsPerRound: TOOL_NAMES.length,
          rounds: ROUNDS,
          pageLimit: 50,
        },
        targetMs: TARGET_MS,
        percentileMethod:
          "nearest rank among current successful full responses",
        tools: observed,
        expected:
          "at least 50 current successes per tool, every current response <= 2000 ms",
        actual: passed ? "PASS" : "FAIL",
        limitation:
          "timed rounds use static queued/event page pressure and concurrent reads; delayed writes and held ingress are deterministic fixture evidence. macOS synthetic load is not Linux Runtime, credential isolation, Stop Evidence, complete issue-21/G5/S6 or production latency evidence",
        resultLocation,
      };
      await mkdir(RESULT_DIRECTORY, { recursive: true });
      await writeFile(resultLocation, `${JSON.stringify(record, null, 2)}\n`);
      console.log(`AP-014 sanitized observation: ${resultLocation}`);
      console.log(JSON.stringify({ result: record.actual, tools: observed }));
      if (!passed) throw new Error("AP-014 current-query timing target missed");
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await endpoint.close();
      await fixture.close();
      if (!setupComplete) console.log("AP-014 timing setup did not complete");
    }
  });
});
