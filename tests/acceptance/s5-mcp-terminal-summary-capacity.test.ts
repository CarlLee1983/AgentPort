import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { join } from "node:path";

import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import type {
  ExecutionSupervisor,
  VerifiedStopEvidence,
} from "../../src/core/execution-supervisor.js";
import type { ExecutionReference } from "../../src/core/types.js";
import { ControlledRuntimeDispatcher } from "../../src/dispatcher/controlled-runtime-dispatcher.js";
import { MCP_PROTOCOL_VERSION } from "../../src/mcp/protocol.js";
import { LOOPBACK_MAX_REQUEST_BODY_BYTES } from "../../src/mcp/loopback-server.js";
import { listTasksSuccessSchema } from "../../src/mcp/schemas.js";
import {
  TERMINAL_TASK_PAGE_RESPONSE_BYTES,
  terminalTaskPageResponseBody,
} from "../../src/mcp/terminal-task-page-response.js";
import { RuntimeWorkerIngress } from "../../src/runtime/worker/ingress.js";
import { RuntimeWorkerIngressClient } from "../../src/runtime/worker/ingress-client.js";
import {
  encodeWorkerObservation,
  RuntimeWorkerObservationSequence,
} from "../../src/runtime/worker/protocol.js";
import {
  createDurableAdmissionFixture,
  INVALID_TOKEN,
  SCOPE_A_TOKEN,
  SCOPE_B_TOKEN,
  type DurableAdmissionFixture,
} from "../fixtures/durable-admission.js";
import {
  connectDurableAdmissionClient,
  expectStructuredTextAgreement,
  startDurableAdmissionMcpEndpoint,
} from "../fixtures/durable-admission-mcp.js";

const PRIVATE_INSTRUCTION = "AP019-PRIVATE-INSTRUCTION-MARKER";
const PRIVATE_RESULT = "AP019-PRIVATE-RESULT-MARKER";
const SYNTHETIC_REFERENCE = "ap019-synthetic-terminal-reference";
const RESULT_DIRECTORY = "node_modules/.cache/agentport-ap019";
const TARGET_BYTES = TERMINAL_TASK_PAGE_RESPONSE_BYTES;
const TASK_COUNT = 100;

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

interface PageObservation {
  taskIds: string[];
  nextCursor: string | null;
}

interface RawPageObservation extends PageObservation {
  layerBytes: {
    structuredResult: number;
    jsonText: number;
    serializedTextContent: number;
    jsonRpcResponseBody: number;
  };
}

interface BoundaryObservation {
  summary: string;
  repeatCount: number;
  logicalSummaryBytes: number;
  acceptedWorkerFrameBytes: number;
  rejectedWorkerFrameBytes: number;
  rejectionOwner:
    "encodeWorkerObservation" | "RuntimeWorkerObservationSequence";
}

interface CompletedTask {
  taskId: string;
  workerFrameBytes: number;
}

interface SanitizedFixtureRecord {
  fixture: {
    label: string;
    repeatedCodePoint: string;
    privateMarkerBytes: number;
    taskCount: number;
  };
  derivation: {
    acceptedRepeatCount: number;
    rejectedRepeatCount: number;
    perItemLogicalSummaryBytes: number;
    acceptedWorkerFrameBytes: number;
    rejectedWorkerFrameBytes: number;
    rejectionOwner: BoundaryObservation["rejectionOwner"];
  };
  expected: {
    requestedUpperBounds: { default: 50; maximum: 100 };
    responseBodyMaximumBytes: number;
  };
  actual: {
    officialClient: Record<
      string,
      { itemCount: number; pageCount: number; nextCursor: string }
    >;
    rawLoopback: Record<
      string,
      {
        itemCount: number;
        nextCursor: string;
        layers: Record<
          string,
          {
            observedBytes: number;
            targetBytes: number;
            differenceBytes: number;
          }
        >;
      }
    >;
    privacy: {
      foreignFreshPageItemCount: number;
      foreignCursorResult: "not_found";
      revokedFreshReadResult: "access_denied";
      invalidBearerHttpStatus: 401;
      invalidBearerAuditResult: "unauthorized";
      revokedAuditResult: "access_denied";
      eventCount: number;
      auditRecordCount: number;
    };
  };
}

function candidate(reference: ExecutionReference, summary: string) {
  return {
    kind: "candidate" as const,
    reference,
    ordinal: 1,
    finalOrdinal: 1,
    outcome: "succeeded" as const,
    summary,
    sessionReference: null,
  };
}

function workerAccepts(
  reference: ExecutionReference,
  summary: string,
): boolean {
  let encoded: string;
  try {
    encoded = encodeWorkerObservation(candidate(reference, summary));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Worker observation exceeds the protocol bound"
    ) {
      return false;
    }
    throw error;
  }
  return (
    new RuntimeWorkerObservationSequence().accept(reference, encoded) !==
    undefined
  );
}

function deriveBoundary(
  reference: ExecutionReference,
  repeated: "漢" | '"',
): BoundaryObservation {
  const summaryFor = (repeatCount: number): string =>
    `${PRIVATE_RESULT}${repeated.repeat(repeatCount)}`;
  let accepted = 0;
  let rejected = 1;
  while (workerAccepts(reference, summaryFor(rejected))) {
    accepted = rejected;
    rejected *= 2;
    if (rejected > 1024 * 1024) {
      throw new Error("Worker candidate boundary was not bounded");
    }
  }
  while (rejected - accepted > 1) {
    const middle = Math.floor((accepted + rejected) / 2);
    if (workerAccepts(reference, summaryFor(middle))) accepted = middle;
    else rejected = middle;
  }

  const summary = summaryFor(accepted);
  const rejectedSummary = summaryFor(rejected);
  const acceptedFrame = encodeWorkerObservation(candidate(reference, summary));
  let rejectionOwner: BoundaryObservation["rejectionOwner"];
  try {
    const rejectedFrame = encodeWorkerObservation(
      candidate(reference, rejectedSummary),
    );
    if (
      new RuntimeWorkerObservationSequence().accept(
        reference,
        rejectedFrame,
      ) !== undefined
    ) {
      throw new Error("The first rejected repeat unexpectedly passed ingress");
    }
    rejectionOwner = "RuntimeWorkerObservationSequence";
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Worker observation exceeds the protocol bound"
    ) {
      rejectionOwner = "encodeWorkerObservation";
    } else {
      throw error;
    }
  }
  if (
    !workerAccepts(reference, summary) ||
    workerAccepts(reference, rejectedSummary)
  ) {
    throw new Error("Binary-searched worker boundary was not adjacent");
  }
  return {
    summary,
    repeatCount: accepted,
    logicalSummaryBytes: Buffer.byteLength(summary, "utf8"),
    acceptedWorkerFrameBytes: Buffer.byteLength(acceptedFrame, "utf8"),
    rejectedWorkerFrameBytes: Buffer.byteLength(
      JSON.stringify(candidate(reference, rejectedSummary)),
      "utf8",
    ),
    rejectionOwner,
  };
}

function createVerifiedStopHarness(): {
  supervisor: ExecutionSupervisor;
  verifier: {
    verify(value: unknown): Omit<VerifiedStopEvidence, "kind"> | undefined;
  };
} {
  const authentic = new WeakSet<object>();
  return {
    verifier: {
      verify(value) {
        if (
          typeof value !== "object" ||
          value === null ||
          !authentic.has(value)
        ) {
          return undefined;
        }
        const evidence = value as VerifiedStopEvidence;
        return {
          platform: evidence.platform,
          reference: { ...evidence.reference },
          executionUnitId: evidence.executionUnitId,
          generationSealedAt: evidence.generationSealedAt,
          unitEmptyObservedAt: evidence.unitEmptyObservedAt,
        };
      },
    },
    supervisor: {
      start(reference) {
        return Promise.resolve({
          kind: "started",
          executionUnitId: `ap017-unit-${reference.executionId}`,
        });
      },
      revokeAndStop(reference) {
        const evidence: VerifiedStopEvidence = {
          kind: "verified",
          platform: "linux-cgroup-v2",
          reference,
          executionUnitId: `ap017-unit-${reference.executionId}`,
          generationSealedAt: "2026-09-16T00:00:01.000Z",
          unitEmptyObservedAt: "2026-09-16T00:00:02.000Z",
        };
        authentic.add(evidence);
        return Promise.resolve({ kind: "stopped", evidence });
      },
      reconcile() {
        return Promise.resolve({ kind: "indeterminate" });
      },
    },
  };
}

async function completeTaskThroughWorker(
  fixture: DurableAdmissionFixture,
  supervisor: ExecutionSupervisor,
  index: number,
  summaryForReference: (reference: ExecutionReference) => string,
): Promise<CompletedTask & { reference: ExecutionReference; summary: string }> {
  const submitted = await fixture.service.submitTask(
    { principalId: "principal-a" },
    {
      operationId: `ap017-submit-${index.toString().padStart(3, "0")}`,
      agentId: "agent-a",
      instruction: `${PRIVATE_INSTRUCTION}-${index.toString().padStart(3, "0")}`,
    },
  );
  let opened: RuntimeWorkerIngress | undefined;
  let openedReference: ExecutionReference | undefined;
  const dispatcher = new ControlledRuntimeDispatcher(
    fixture.service,
    { dispatchAuthority: () => Promise.resolve(SYNTHETIC_REFERENCE) },
    supervisor,
    {
      async open({ reference, lifecycle }) {
        openedReference = reference;
        opened = await RuntimeWorkerIngress.open({
          endpoint: join(
            fixture.directory,
            `ap017-${index.toString().padStart(3, "0")}.sock`,
          ),
          reference,
          lifecycle,
        });
        return {
          session: opened.session,
          close: () => opened?.close() ?? Promise.resolve(),
        };
      },
    },
  );
  const dispatch = await dispatcher.dispatch(submitted.task.taskId);
  if (
    dispatch.kind !== "started" ||
    opened === undefined ||
    openedReference === undefined
  ) {
    await opened?.close();
    throw new Error("Synthetic worker dispatch did not start");
  }

  const reference = openedReference;
  const summary = summaryForReference(reference);
  const encoded = encodeWorkerObservation(candidate(reference, summary));
  const worker = await RuntimeWorkerIngressClient.connect(opened.session);
  try {
    await worker.emit(encoded, 1, "candidate");
    await expect
      .poll(async () => {
        const execution = await fixture.store.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        });
        return {
          workspaceClaim: execution?.workspaceClaim,
        };
      })
      .toEqual({ workspaceClaim: "released" });
    const terminal = await fixture.service.getTask(
      { principalId: "principal-a" },
      { taskId: submitted.task.taskId },
    );
    if (
      terminal.state !== "completed" ||
      terminal.result?.kind !== "completed" ||
      terminal.result.summary !== summary
    ) {
      throw new Error("Verified stop did not durably terminalize the Task");
    }
  } finally {
    worker.close();
    await opened.close();
  }
  return {
    taskId: submitted.task.taskId,
    reference,
    summary,
    workerFrameBytes: Buffer.byteLength(encoded, "utf8"),
  };
}

function structured(result: ToolResult): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  expectStructuredTextAgreement(result);
  expect(result.structuredContent).toBeTypeOf("object");
  return result.structuredContent as Record<string, unknown>;
}

function assertPage(
  payload: Record<string, unknown>,
  summary: string,
  maximumCount: number,
): PageObservation {
  const parsed = listTasksSuccessSchema.safeParse(payload);
  if (!parsed.success)
    throw new Error("Task page failed its public output schema");
  if (
    parsed.data.tasks.length === 0 ||
    parsed.data.tasks.length > maximumCount
  ) {
    throw new Error("Task page violated its requested-count upper bound");
  }
  for (const task of parsed.data.tasks) {
    if (Object.prototype.hasOwnProperty.call(task, "instruction")) {
      throw new Error("Task summary exposed instruction");
    }
    if (
      task.state !== "completed" ||
      task.result?.kind !== "completed" ||
      task.result.summary !== summary
    ) {
      throw new Error("Task page returned an incomplete terminal summary");
    }
  }
  return {
    taskIds: parsed.data.tasks.map((task) => task.taskId),
    nextCursor: parsed.data.nextCursor,
  };
}

async function officialPage(
  client: Client,
  args: Record<string, unknown>,
  summary: string,
  maximumCount: number,
): Promise<PageObservation> {
  return assertPage(
    structured(
      await client.callTool({
        name: "agentport_list_tasks",
        arguments: args,
      }),
    ),
    summary,
    maximumCount,
  );
}

let rawRequestSequence = 0;

function rawCall(
  name: string,
  args: Record<string, unknown>,
  requestId?: string,
): Record<string, unknown> {
  const id = requestId ?? `ap019-raw-${(++rawRequestSequence).toString()}`;
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": {
          name: "ap019-capacity-reader",
          version: "1.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

function rawHeaders(
  name: string,
  token = SCOPE_A_TOKEN,
): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "mcp-method": "tools/call",
    "mcp-name": name,
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  };
}

async function rawPage(
  url: URL,
  args: Record<string, unknown>,
  summary: string,
  maximumCount: number,
  requestId?: string,
): Promise<RawPageObservation> {
  const call = rawCall("agentport_list_tasks", args, requestId);
  const response = await fetch(url, {
    method: "POST",
    headers: rawHeaders("agentport_list_tasks"),
    body: JSON.stringify(call),
  });
  if (response.status !== 200)
    throw new Error("Raw Task page HTTP request failed");
  const body = await response.text();
  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch {
    throw new Error("Raw Task page was not valid JSON");
  }
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    Array.isArray(envelope)
  ) {
    throw new Error("Raw Task page JSON-RPC envelope was invalid");
  }
  const record = envelope as Record<string, unknown>;
  if (
    record.jsonrpc !== "2.0" ||
    record.id !== call.id ||
    record.error !== undefined
  ) {
    throw new Error("Raw Task page returned a JSON-RPC error");
  }
  if (typeof record.result !== "object" || record.result === null) {
    throw new Error("Raw Task page omitted its MCP result");
  }
  const result = record.result as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
  };
  if (result.isError === true)
    throw new Error("Raw Task page returned an MCP error");
  expectStructuredTextAgreement(result);
  if (
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null ||
    Array.isArray(result.structuredContent)
  ) {
    throw new Error("Raw Task page omitted structured content");
  }
  const first = result.content[0];
  if (first?.type !== "text" || first.text === undefined) {
    throw new Error("Raw Task page omitted JSON TextContent");
  }
  const payload = result.structuredContent as Record<string, unknown>;
  const parsed = listTasksSuccessSchema.safeParse(payload);
  if (!parsed.success)
    throw new Error("Raw Task page failed its output schema");
  expect(
    terminalTaskPageResponseBody(
      { tasks: parsed.data.tasks, nextCursor: parsed.data.nextCursor },
      call.id,
    ),
  ).toBe(body);
  expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(TARGET_BYTES);
  return {
    ...assertPage(payload, summary, maximumCount),
    layerBytes: {
      structuredResult: Buffer.byteLength(
        JSON.stringify(result.structuredContent),
        "utf8",
      ),
      jsonText: Buffer.byteLength(first.text, "utf8"),
      serializedTextContent: Buffer.byteLength(
        JSON.stringify(result.content),
        "utf8",
      ),
      jsonRpcResponseBody: Buffer.byteLength(body, "utf8"),
    },
  };
}

function largestLegalRequestId(args: Record<string, unknown>): string {
  const bodyWithEmptyId = JSON.stringify(
    rawCall("agentport_list_tasks", args, ""),
  );
  const remainingBytes =
    LOOPBACK_MAX_REQUEST_BODY_BYTES -
    Buffer.byteLength(bodyWithEmptyId, "utf8");
  if (remainingBytes < 1) {
    throw new Error("Raw Task request envelope left no legal request-id bytes");
  }
  return "i".repeat(remainingBytes);
}

async function drainOfficialPages(
  client: Client,
  input: Record<string, unknown>,
  summary: string,
): Promise<PageObservation[]> {
  const pages: PageObservation[] = [];
  let cursor: string | undefined;
  const maximumCount = typeof input.limit === "number" ? input.limit : 50;
  do {
    const page = await officialPage(
      client,
      {
        ...input,
        ...(cursor === undefined ? {} : { cursor }),
      },
      summary,
      maximumCount,
    );
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return pages;
}

async function drainRawPages(
  url: URL,
  input: Record<string, unknown>,
  summary: string,
  requestIdFor?: (args: Record<string, unknown>) => string,
): Promise<RawPageObservation[]> {
  const pages: RawPageObservation[] = [];
  let cursor: string | undefined;
  const maximumCount = typeof input.limit === "number" ? input.limit : 50;
  do {
    const page = await rawPage(
      url,
      {
        ...input,
        ...(cursor === undefined ? {} : { cursor }),
      },
      summary,
      maximumCount,
      requestIdFor?.({
        ...input,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return pages;
}

function rejected(result: ToolResult, code: string): void {
  assertSanitized(JSON.stringify(result), "application error");
  expect(result.isError).toBe(true);
  expectStructuredTextAgreement(result);
  expect(result.structuredContent).toMatchObject({
    ok: false,
    error: { code },
  });
}

function assertSanitized(value: string, sink: string): void {
  if (
    [PRIVATE_INSTRUCTION, PRIVATE_RESULT, SYNTHETIC_REFERENCE].some((secret) =>
      value.includes(secret),
    )
  ) {
    throw new Error(`Private marker entered ${sink}`);
  }
}

function assertSameTasks(
  left: readonly string[],
  right: readonly string[],
): void {
  if (
    left.length !== right.length ||
    left.some((id, index) => id !== right[index])
  ) {
    throw new Error("Task pages did not describe the same complete snapshot");
  }
}

function comparison(observedBytes: number) {
  return {
    observedBytes,
    targetBytes: TARGET_BYTES,
    differenceBytes: observedBytes - TARGET_BYTES,
  };
}

function cursorOutcome(cursor: string | null): string {
  return cursor === null ? "null" : "non-null";
}

function pageRecord(
  page: RawPageObservation,
  logicalSummaryBytes: number,
  frameBytesByTaskId: ReadonlyMap<string, number>,
) {
  const workerFrameBytes = page.taskIds.reduce((total, taskId) => {
    const bytes = frameBytesByTaskId.get(taskId);
    if (bytes === undefined)
      throw new Error("Task page had no worker-frame evidence");
    return total + bytes;
  }, 0);
  return {
    itemCount: page.taskIds.length,
    nextCursor: cursorOutcome(page.nextCursor),
    layers: {
      logicalSummary: comparison(logicalSummaryBytes * page.taskIds.length),
      workerFrame: comparison(workerFrameBytes),
      structuredResult: comparison(page.layerBytes.structuredResult),
      jsonText: comparison(page.layerBytes.jsonText),
      serializedTextContent: comparison(page.layerBytes.serializedTextContent),
      jsonRpcResponseBody: comparison(page.layerBytes.jsonRpcResponseBody),
    },
  };
}

async function allEvents(
  client: Client,
): Promise<{ count: number; serialized: string }> {
  let afterCursor: string | undefined;
  let count = 0;
  const serializedPages: string[] = [];
  for (;;) {
    const payload = structured(
      await client.callTool({
        name: "agentport_get_events",
        arguments: {
          limit: 100,
          ...(afterCursor === undefined ? {} : { afterCursor }),
        },
      }),
    );
    const events = payload.events;
    if (!Array.isArray(events)) throw new Error("Event page omitted events");
    count += events.length;
    serializedPages.push(JSON.stringify(payload));
    if (payload.nextCursor === null) break;
    if (typeof payload.nextCursor !== "string") {
      throw new Error("Event page returned an invalid cursor");
    }
    afterCursor = payload.nextCursor;
  }
  return { count, serialized: serializedPages.join("") };
}

async function sourceDigest(): Promise<string> {
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

async function writeRecord(
  fixtures: readonly SanitizedFixtureRecord[],
  sourceSha256Before: string,
): Promise<string> {
  await mkdir(RESULT_DIRECTORY, { recursive: true });
  const path = join(
    RESULT_DIRECTORY,
    `terminal-summary-capacity-${Date.now().toString()}.json`,
  );
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    packageManager: string;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const sourceSha256After = await sourceDigest();
  expect(sourceSha256After).toBe(sourceSha256Before);
  const content = {
    scenario: "ap019-terminal-summary-capacity-safe-pagination",
    candidate: {
      baseRevision: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      sourceSha256Before,
      sourceSha256After,
    },
    platform: { os: platform(), release: release(), arch: arch() },
    versions: {
      node: process.version,
      pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
      packageManager: manifest.packageManager,
      mcpProtocol: MCP_PROTOCOL_VERSION,
      mcpClient: manifest.dependencies["@modelcontextprotocol/client"],
      mcpServer: manifest.dependencies["@modelcontextprotocol/server"],
      sqlite: manifest.dependencies["better-sqlite3"],
      vitest: manifest.devDependencies.vitest,
    },
    target: {
      documentedBytes: TARGET_BYTES,
      authoritativeLayer: "complete-uncompressed-utf8-json-rpc-response-body",
      capacityVerdict: "all-emitted-terminal-pages-at-most-8388608-bytes",
    },
    fixtures,
    residualDecisions: [
      "other MCP tools require their own response-capacity evidence and Story",
      "five-second Client outage and production backpressure remain unproven",
      "Linux Stop Evidence, complete G5, S6, and release acceptance remain unproven",
    ],
    resultLocation: path,
  };
  const serialized = `${JSON.stringify(content, null, 2)}\n`;
  assertSanitized(serialized, "sanitized candidate record");
  await writeFile(path, serialized);
  const written = await readFile(path, "utf8");
  if (written !== serialized) {
    throw new Error("Sanitized candidate record was not written exactly");
  }
  process.stdout.write(
    `${JSON.stringify({ scenario: content.scenario, resultLocation: path })}\n`,
  );
  return path;
}

async function characterizeFixture(
  label: string,
  repeated: "漢" | '"',
  repeatedCodePoint: "U+6F22" | "U+0022",
): Promise<SanitizedFixtureRecord> {
  const stopHarness = createVerifiedStopHarness();
  let idSequence = 0;
  const fixture = await createDurableAdmissionFixture(
    {},
    {
      newId: () => `ap017-id-${(++idSequence).toString().padStart(6, "0")}`,
      stopEvidenceVerifier: stopHarness.verifier,
    },
  );
  let endpoint:
    Awaited<ReturnType<typeof startDurableAdmissionMcpEndpoint>> | undefined;
  let client: Client | undefined;
  let foreign: Client | undefined;
  try {
    let boundary: BoundaryObservation | undefined;
    const completed: CompletedTask[] = [];
    for (let index = 0; index < TASK_COUNT; index++) {
      const task = await completeTaskThroughWorker(
        fixture,
        stopHarness.supervisor,
        index,
        (reference) => {
          boundary ??= deriveBoundary(reference, repeated);
          return boundary.summary;
        },
      );
      completed.push(task);
      const currentBoundary = boundary;
      if (currentBoundary === undefined) {
        throw new Error("Terminal Task boundary was not derived");
      }
      if (task.summary !== currentBoundary.summary) {
        throw new Error("Terminal Task did not preserve the derived fixture");
      }
      if (task.workerFrameBytes !== currentBoundary.acceptedWorkerFrameBytes) {
        throw new Error("Deterministic worker References changed frame size");
      }
    }
    if (boundary === undefined || completed.length !== TASK_COUNT) {
      throw new Error("Terminal Task fixture was incomplete");
    }
    const frameBytesByTaskId = new Map(
      completed.map((task) => [task.taskId, task.workerFrameBytes]),
    );

    endpoint = await startDurableAdmissionMcpEndpoint(fixture);
    client = await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN);
    foreign = await connectDurableAdmissionClient(endpoint.url, SCOPE_B_TOKEN);

    const officialDefault = await drainOfficialPages(
      client,
      {},
      boundary.summary,
    );
    const officialFirst = officialDefault[0];
    if (officialFirst === undefined) throw new Error("Missing official page");
    if (officialFirst.nextCursor === null)
      throw new Error("Missing official cursor");
    const officialMaximum = await drainOfficialPages(
      client,
      { limit: 100 },
      boundary.summary,
    );
    if (label === "utf8-multibyte") {
      expect(officialDefault.map((page) => page.taskIds.length)).toEqual([
        50, 50,
      ]);
      expect(officialMaximum.map((page) => page.taskIds.length)).toEqual([100]);
    }
    assertSameTasks(
      officialDefault.flatMap((page) => page.taskIds),
      officialMaximum.flatMap((page) => page.taskIds),
    );
    assertSameTasks(
      officialDefault.flatMap((page) => page.taskIds),
      completed.map((task) => task.taskId),
    );

    const rawDefault = await drainRawPages(endpoint.url, {}, boundary.summary);
    const rawFirst = rawDefault[0];
    if (rawFirst === undefined) throw new Error("Missing raw page");
    if (rawFirst.nextCursor === null) throw new Error("Missing raw cursor");
    const rawMaximum = await drainRawPages(
      endpoint.url,
      { limit: 100, state: "completed" },
      boundary.summary,
    );
    assertSameTasks(
      rawDefault.flatMap((page) => page.taskIds),
      rawMaximum.flatMap((page) => page.taskIds),
    );
    assertSameTasks(
      rawDefault.flatMap((page) => page.taskIds),
      completed.map((task) => task.taskId),
    );
    assertSameTasks(
      officialDefault.flatMap((page) => page.taskIds),
      rawDefault.flatMap((page) => page.taskIds),
    );

    const longIdPages = await drainRawPages(
      endpoint.url,
      { limit: 100, state: "completed" },
      boundary.summary,
      largestLegalRequestId,
    );
    assertSameTasks(
      longIdPages.flatMap((page) => page.taskIds),
      completed.map((task) => task.taskId),
    );

    const foreignFresh = structured(
      await foreign.callTool({
        name: "agentport_list_tasks",
        arguments: { limit: 100 },
      }),
    );
    assertSanitized(JSON.stringify(foreignFresh), "foreign fresh page");
    const foreignFreshTasks = foreignFresh.tasks;
    if (!Array.isArray(foreignFreshTasks) || foreignFreshTasks.length !== 0) {
      throw new Error("Foreign Principal observed terminal Tasks");
    }
    rejected(
      await foreign.callTool({
        name: "agentport_list_tasks",
        arguments: { cursor: officialFirst.nextCursor },
      }),
      "not_found",
    );
    rejected(
      await client.callTool({
        name: "agentport_list_tasks",
        arguments: { cursor: officialFirst.nextCursor, state: "queued" },
      }),
      "not_found",
    );
    rejected(
      await client.callTool({
        name: "agentport_list_tasks",
        arguments: { cursor: "malformed" },
      }),
      "not_found",
    );

    const events = await allEvents(client);
    assertSanitized(events.serialized, "event projection");

    if (repeated === '"') {
      const cursor = longIdPages[0]?.nextCursor;
      if (cursor === null || cursor === undefined) {
        throw new Error("Expected a capacity-selected terminal cursor");
      }
      await fixture.store.expireRetainedData({
        asOf: "2027-01-15T00:00:00.000Z",
      });
      rejected(
        await client.callTool({
          name: "agentport_list_tasks",
          arguments: { cursor, state: "completed" },
        }),
        "cursor_expired",
      );
    }

    const invalidBearer = await fetch(endpoint.url, {
      method: "POST",
      headers: rawHeaders("agentport_list_tasks", INVALID_TOKEN),
      body: JSON.stringify(rawCall("agentport_list_tasks", { limit: 100 })),
    });
    expect(invalidBearer.status).toBe(401);
    const invalidBearerBody = await invalidBearer.text();
    assertSanitized(invalidBearerBody, "authentication error");

    await fixture.registry.replace({
      ...fixture.registryConfiguration,
      principals: fixture.registryConfiguration.principals.map((principal) =>
        principal.principalId === "principal-a"
          ? { ...principal, active: false }
          : principal,
      ),
    });
    rejected(
      await client.callTool({
        name: "agentport_list_tasks",
        arguments: { limit: 100 },
      }),
      "access_denied",
    );

    await endpoint.flushAudit();
    const audit = (await fixture.store.probe("inspectProductAudit")) as {
      records: Array<Record<string, unknown>>;
    };
    const serializedAudit = JSON.stringify(audit);
    assertSanitized(serializedAudit, "product audit");
    const invalidBearerAudited = audit.records.some(
      (record) =>
        record.principalId === null &&
        record.method === "tools/call" &&
        record.resultCode === "unauthorized",
    );
    const revokedReadAudited = audit.records.some(
      (record) =>
        record.principalId === "principal-a" &&
        record.method === "tools/call" &&
        record.toolName === "agentport_list_tasks" &&
        record.resultCode === "access_denied",
    );
    if (!invalidBearerAudited || !revokedReadAudited) {
      throw new Error("Required sanitized denial audit outcomes were absent");
    }

    return {
      fixture: {
        label,
        repeatedCodePoint,
        privateMarkerBytes: Buffer.byteLength(PRIVATE_RESULT, "utf8"),
        taskCount: completed.length,
      },
      derivation: {
        acceptedRepeatCount: boundary.repeatCount,
        rejectedRepeatCount: boundary.repeatCount + 1,
        perItemLogicalSummaryBytes: boundary.logicalSummaryBytes,
        acceptedWorkerFrameBytes: boundary.acceptedWorkerFrameBytes,
        rejectedWorkerFrameBytes: boundary.rejectedWorkerFrameBytes,
        rejectionOwner: boundary.rejectionOwner,
      },
      expected: {
        requestedUpperBounds: { default: 50, maximum: 100 },
        responseBodyMaximumBytes: TARGET_BYTES,
      },
      actual: {
        officialClient: {
          defaultFirst: {
            itemCount: officialFirst.taskIds.length,
            pageCount: 1,
            nextCursor: cursorOutcome(officialFirst.nextCursor),
          },
          defaultDrain: {
            itemCount: officialDefault.flatMap((page) => page.taskIds).length,
            pageCount: officialDefault.length,
            nextCursor: "null",
          },
          maximumDrain: {
            itemCount: officialMaximum.flatMap((page) => page.taskIds).length,
            pageCount: officialMaximum.length,
            nextCursor: "null",
          },
        },
        rawLoopback: {
          defaultFirst: pageRecord(
            rawFirst,
            boundary.logicalSummaryBytes,
            frameBytesByTaskId,
          ),
          defaultContinuation: pageRecord(
            rawDefault.at(-1) ?? rawFirst,
            boundary.logicalSummaryBytes,
            frameBytesByTaskId,
          ),
          maximum: pageRecord(
            rawMaximum[0] ?? rawFirst,
            boundary.logicalSummaryBytes,
            frameBytesByTaskId,
          ),
        },
        privacy: {
          foreignFreshPageItemCount: foreignFreshTasks.length,
          foreignCursorResult: "not_found",
          revokedFreshReadResult: "access_denied",
          invalidBearerHttpStatus: 401,
          invalidBearerAuditResult: "unauthorized",
          revokedAuditResult: "access_denied",
          eventCount: events.count,
          auditRecordCount: audit.records.length,
        },
      },
    };
  } finally {
    await client?.close().catch(() => undefined);
    await foreign?.close().catch(() => undefined);
    await endpoint?.close().catch(() => undefined);
    await fixture.close();
  }
}

describe("AP-019 terminal Task-summary capacity-safe pagination", () => {
  it("preserves every terminal Task-state projection", async () => {
    const fixture = await createDurableAdmissionFixture();
    let endpoint:
      Awaited<ReturnType<typeof startDurableAdmissionMcpEndpoint>> | undefined;
    let client: Client | undefined;
    const actor = { principalId: "principal-a" };
    try {
      const canceled = await fixture.service.submitTask(actor, {
        operationId: "ap019-terminal-canceled-submit",
        agentId: "agent-a",
        instruction: "AP019-TERMINAL-CANCELED-INSTRUCTION",
      });
      await fixture.service.cancelTask(actor, {
        operationId: "ap019-terminal-canceled-cancel",
        taskId: canceled.task.taskId,
      });

      const failed = await fixture.service.submitTask(actor, {
        operationId: "ap019-terminal-failed-submit",
        agentId: "agent-a",
        instruction: "AP019-TERMINAL-FAILED-INSTRUCTION",
      });
      const failedPreparation = await fixture.service.prepareForDispatch(
        failed.task.taskId,
        "ap019-terminal-failed-epoch",
      );
      await fixture.service.markExecutionRunning(failedPreparation.reference);
      await fixture.recordObservation(actor, {
        taskId: failed.task.taskId,
        observation: {
          kind: "candidate",
          reference: failedPreparation.reference,
          ordinal: 1,
          finalOrdinal: 1,
          outcome: { kind: "failed", summary: "AP019 failed summary" },
          sessionReference: null,
        },
      });
      await fixture.store.commitTerminal({
        evidence: {
          platform: "linux-cgroup-v2",
          reference: failedPreparation.reference,
          executionUnitId: "ap019-terminal-failed-unit",
          generationSealedAt: "2026-09-14T00:00:01.000Z",
          unitEmptyObservedAt: "2026-09-14T00:00:02.000Z",
        },
      });

      const interrupted = await fixture.service.submitTask(actor, {
        operationId: "ap019-terminal-interrupted-submit",
        agentId: "agent-a",
        instruction: "AP019-TERMINAL-INTERRUPTED-INSTRUCTION",
      });
      const interruptedPreparation = await fixture.service.prepareForDispatch(
        interrupted.task.taskId,
        "ap019-terminal-interrupted-epoch",
      );
      await fixture.service.markExecutionRunning(
        interruptedPreparation.reference,
      );
      await fixture.store.recoverExecutions();
      const recovering = await fixture.service.getTask(actor, {
        taskId: interrupted.task.taskId,
      });
      await fixture.store.confirmRecoveryStopped({
        evidence: {
          platform: "linux-cgroup-v2",
          reference: interruptedPreparation.reference,
          executionUnitId: "ap019-terminal-interrupted-unit",
          generationSealedAt: "2026-09-14T00:00:03.000Z",
          unitEmptyObservedAt: "2026-09-14T00:00:04.000Z",
        },
        now: "2026-09-14T00:00:05.000Z",
      });
      await fixture.service.acknowledgeInterruption(actor, {
        operationId: "ap019-terminal-interrupted-acknowledge",
        taskId: interrupted.task.taskId,
        expectedRevision: recovering.revision,
      });

      endpoint = await startDurableAdmissionMcpEndpoint(fixture);
      client = await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN);
      const page = listTasksSuccessSchema.parse(
        structured(
          await client.callTool({
            name: "agentport_list_tasks",
            arguments: { limit: 100 },
          }),
        ),
      );
      const terminalSnapshots = await Promise.all(
        [canceled, failed, interrupted].map(async ({ task }) =>
          fixture.service.getTask(actor, { taskId: task.taskId }),
        ),
      );
      for (const expected of terminalSnapshots) {
        const observed = page.tasks.find(
          ({ taskId }) => taskId === expected.taskId,
        );
        expect(observed).toMatchObject({
          taskId: expected.taskId,
          state: expected.state,
          reason: expected.reason,
          result: expected.result,
        });
      }
      const failedSummary = page.tasks.find(
        ({ taskId }) => taskId === failed.task.taskId,
      );
      expect(failedSummary?.result).toEqual({
        kind: "failed",
        summary: "AP019 failed summary",
      });
      expect(JSON.stringify(page)).not.toContain("AP019-TERMINAL-");
    } finally {
      await client?.close().catch(() => undefined);
      await endpoint?.close().catch(() => undefined);
      await fixture.close();
    }
  });

  it("bounds actual response bodies and drains UTF-8 and JSON-escape terminal pages exactly once", async () => {
    const sourceSha256Before = await sourceDigest();
    const fixtures = [
      await characterizeFixture("utf8-multibyte", "漢", "U+6F22"),
      await characterizeFixture("json-escape", '"', "U+0022"),
    ];
    const resultLocation = await writeRecord(fixtures, sourceSha256Before);
    expect(resultLocation.startsWith(`${RESULT_DIRECTORY}/`)).toBe(true);
  }, 120_000);
});
