import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import type {
  ExecutionSupervisor,
  VerifiedStopEvidence,
} from "../../src/core/execution-supervisor.js";
import type { ExecutionReference } from "../../src/core/types.js";
import { ControlledRuntimeDispatcher } from "../../src/dispatcher/controlled-runtime-dispatcher.js";
import { sessionReferenceFor } from "../../src/runtime/claude/session-reference.js";
import {
  RuntimeWorkerIngress,
  type RuntimeWorkerIngressLifecycle,
} from "../../src/runtime/worker/ingress.js";
import { RuntimeWorkerIngressClient } from "../../src/runtime/worker/ingress-client.js";
import { encodeWorkerObservation } from "../../src/runtime/worker/protocol.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

const reference: ExecutionReference = {
  executionId: "ingress-execution-1",
  generation: "ingress-generation-1",
  daemonEpoch: "ingress-epoch-1",
  launchProfileId: "ingress-profile-1",
  workspaceIdentity: "ingress-workspace-1",
};

async function exchange(
  endpoint: string,
  token: string,
  frames: readonly string[],
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const replies: Record<string, unknown>[] = [];
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const frame = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        replies.push(JSON.parse(frame) as Record<string, unknown>);
        if (replies.length === frames.length + 1) {
          socket.end();
          resolve(replies);
        }
      }
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ kind: "authenticate", token })}\n`);
      for (const frame of frames) socket.write(`${frame}\n`);
    });
  });
}

describe("S3-B Reference-bound Runtime ingress", () => {
  it("converges an authenticated worker loss to failed and releases its claim", async () => {
    const authentic = new WeakSet<object>();
    const fixture = await createDurableAdmissionFixture(
      {},
      {
        stopEvidenceVerifier: {
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
      },
    );
    const directory = await mkdtemp(join(tmpdir(), "agentport-ingress-loss-"));
    let opened: RuntimeWorkerIngress | undefined;
    let worker: RuntimeWorkerIngressClient | undefined;
    const supervisor: ExecutionSupervisor = {
      start: () =>
        Promise.resolve({
          kind: "started",
          executionUnitId: "agentport-execution-worker-loss",
        }),
      revokeAndStop(stoppedReference) {
        const evidence: VerifiedStopEvidence = {
          kind: "verified",
          platform: "linux-cgroup-v2",
          reference: stoppedReference,
          executionUnitId: "agentport-execution-worker-loss",
          generationSealedAt: "2026-09-12T08:00:01.000Z",
          unitEmptyObservedAt: "2026-09-12T08:00:02.000Z",
        };
        authentic.add(evidence);
        return Promise.resolve({ kind: "stopped", evidence });
      },
      reconcile: () => Promise.resolve({ kind: "indeterminate" }),
    };
    try {
      const submitted = await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "authenticated-worker-loss-submit",
          agentId: "agent-a",
          instruction: "Fail safely when the authenticated worker disappears",
        },
      );
      const dispatcher = new ControlledRuntimeDispatcher(
        fixture.service,
        { dispatchAuthority: () => Promise.resolve("worker-loss-epoch") },
        supervisor,
        {
          async open({ reference: runtimeReference, lifecycle }) {
            opened = await RuntimeWorkerIngress.open({
              endpoint: join(directory, "worker.sock"),
              reference: runtimeReference,
              lifecycle,
            });
            return {
              session: opened.session,
              close: () => opened?.close() ?? Promise.resolve(),
            };
          },
        },
      );
      await expect(dispatcher.dispatch(submitted.task.taskId)).resolves.toEqual(
        { kind: "started" },
      );
      if (opened === undefined)
        throw new Error("Runtime ingress was not opened");
      worker = await RuntimeWorkerIngressClient.connect(opened.session);
      worker.close();
      worker = undefined;

      await expect
        .poll(async () => {
          const current = await fixture.service.getTask(
            { principalId: "principal-a" },
            { taskId: submitted.task.taskId },
          );
          return {
            state: current.state,
            claim: current.execution?.quarantined,
            result: current.result?.kind,
          };
        })
        .toEqual({ state: "failed", claim: false, result: "failed" });
    } finally {
      worker?.close();
      await opened?.close();
      await fixture.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("owns the ingress socket as the daemon uid and the Runtime group", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentport-ingress-owner-"));
    const runtimeGroupId = process.getgid?.();
    if (runtimeGroupId === undefined) {
      throw new Error("Test requires a POSIX process group id");
    }
    const ingress = await RuntimeWorkerIngress.open({
      endpoint: join(directory, "worker.sock"),
      reference,
      lifecycle: {
        persistQuestion: () => Promise.resolve(),
        waitForAcceptedAnswer: () => Promise.resolve({}),
        acknowledgeQuestionDelivery: () => Promise.resolve(),
        markQuestionDeliveryUnknown: () => Promise.resolve(),
        recordObservation: () => Promise.resolve(),
        stopAfterCandidate: () => Promise.resolve(),
        quarantine: () => Promise.resolve(),
      },
      groupId: runtimeGroupId,
    });
    try {
      const metadata = await stat(ingress.session.endpoint);
      expect(metadata.uid).toBe(process.getuid?.());
      expect(metadata.gid).toBe(runtimeGroupId);
      expect(metadata.mode & 0o777).toBe(0o660);
    } finally {
      await ingress.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("closes the server and removes the endpoint when it cannot secure the socket (M1)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentport-ingress-fail-"));
    const endpoint = join(directory, "worker.sock");
    const groups = process.getgroups?.() ?? [];
    const primaryGroupId = process.getgid?.();
    const unownedGroupId = [0, 1, 2, 3, 4, 5, 12, 20, 50, 65534].find(
      (candidate) =>
        candidate !== primaryGroupId && !groups.includes(candidate),
    );
    if (unownedGroupId === undefined) {
      throw new Error(
        "Test requires a group id the current process does not belong to",
      );
    }
    try {
      await expect(
        RuntimeWorkerIngress.open({
          endpoint,
          reference,
          lifecycle: {
            persistQuestion: () => Promise.resolve(),
            waitForAcceptedAnswer: () => Promise.resolve({}),
            acknowledgeQuestionDelivery: () => Promise.resolve(),
            markQuestionDeliveryUnknown: () => Promise.resolve(),
            recordObservation: () => Promise.resolve(),
            stopAfterCandidate: () => Promise.resolve(),
            quarantine: () => Promise.resolve(),
          },
          groupId: unownedGroupId,
        }),
      ).rejects.toThrow();
      await expect(stat(endpoint)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("persists a contiguous candidate before it asks for trusted stopping", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentport-ingress-"));
    const observations: unknown[] = [];
    const calls: string[] = [];
    const protectedSessionToken = "sdk-session-ingress-1";
    const lifecycle: RuntimeWorkerIngressLifecycle = {
      persistQuestion() {
        calls.push("question-persist");
        return Promise.resolve();
      },
      waitForAcceptedAnswer() {
        return Promise.resolve({});
      },
      acknowledgeQuestionDelivery() {
        return Promise.resolve();
      },
      markQuestionDeliveryUnknown() {
        return Promise.resolve();
      },
      recordObservation(observation) {
        observations.push(observation);
        calls.push("persist");
        return Promise.resolve();
      },
      stopAfterCandidate() {
        calls.push("stop");
        return Promise.resolve();
      },
      quarantine() {
        calls.push("quarantine");
        return Promise.resolve();
      },
    };
    const ingress = await RuntimeWorkerIngress.open({
      endpoint: join(directory, "worker.sock"),
      reference,
      lifecycle,
    });
    try {
      const replies = await exchange(
        ingress.session.endpoint,
        ingress.session.token,
        [
          encodeWorkerObservation({
            kind: "progress",
            reference,
            ordinal: 1,
            summary: "worker-ready",
          }),
          encodeWorkerObservation({
            kind: "candidate",
            reference,
            ordinal: 2,
            finalOrdinal: 2,
            outcome: "succeeded",
            summary: "bounded result",
            sessionReference: sessionReferenceFor(
              reference,
              protectedSessionToken,
            ),
            protectedSessionToken,
          }),
        ],
      );

      expect(replies).toEqual([
        { kind: "authenticated" },
        { kind: "accepted", ordinal: 1 },
        { kind: "candidate_persisted", ordinal: 2 },
      ]);
      expect(observations).toMatchObject([
        { kind: "progress", ordinal: 1 },
        {
          kind: "candidate",
          ordinal: 2,
          outcome: { kind: "completed", summary: "bounded result" },
          protectedSessionToken,
        },
      ]);
      expect(calls).toEqual(["persist", "persist", "stop"]);
    } finally {
      await ingress.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a stolen token before it can persist or control an execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentport-ingress-"));
    let observed = false;
    const ingress = await RuntimeWorkerIngress.open({
      endpoint: join(directory, "worker.sock"),
      reference,
      lifecycle: {
        persistQuestion() {
          return Promise.resolve();
        },
        waitForAcceptedAnswer() {
          return Promise.resolve({});
        },
        acknowledgeQuestionDelivery() {
          return Promise.resolve();
        },
        markQuestionDeliveryUnknown() {
          return Promise.resolve();
        },
        recordObservation() {
          observed = true;
          return Promise.resolve();
        },
        stopAfterCandidate() {
          return Promise.resolve();
        },
        quarantine() {
          return Promise.resolve();
        },
      },
    });
    try {
      const closed = await new Promise<boolean>((resolve) => {
        const socket = createConnection(ingress.session.endpoint);
        socket.once("connect", () => {
          socket.write('{"kind":"authenticate","token":"not-the-token"}\n');
        });
        socket.once("close", () => {
          resolve(true);
        });
        socket.once("error", () => {
          resolve(true);
        });
      });
      expect(closed).toBe(true);
      expect(observed).toBe(false);
    } finally {
      await ingress.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a wrong 43-character token without projecting it (AP-021 AC-05)", async () => {
    const sentinel = "ap021-ingress-token-sentinel";
    const wrongToken = sentinel.padEnd(43, "A");
    expect(wrongToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const directory = await mkdtemp(join(tmpdir(), "agentport-ingress-"));
    const lifecycleCalls: unknown[] = [];
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        lifecycleCalls.push({ name, args });
        return Promise.resolve();
      };
    const consoleOutput: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleOutput.push(args);
      });
    }
    const ingress = await RuntimeWorkerIngress.open({
      endpoint: join(directory, "worker.sock"),
      reference,
      lifecycle: {
        persistQuestion: record("persistQuestion"),
        waitForAcceptedAnswer: () => Promise.resolve({}),
        acknowledgeQuestionDelivery: record("acknowledgeQuestionDelivery"),
        markQuestionDeliveryUnknown: record("markQuestionDeliveryUnknown"),
        recordObservation: record("recordObservation"),
        stopAfterCandidate: record("stopAfterCandidate"),
        quarantine: record("quarantine"),
      },
    });
    try {
      const replies = await new Promise<string>((resolve) => {
        let received = "";
        const socket = createConnection(ingress.session.endpoint);
        socket.once("connect", () => {
          socket.write(
            `${JSON.stringify({ kind: "authenticate", token: wrongToken })}\n`,
          );
          socket.write(
            `${JSON.stringify({ kind: "progress", ordinal: 1, summary: "forged" })}\n`,
          );
        });
        socket.on("data", (chunk: Buffer) => {
          received += chunk.toString("utf8");
        });
        socket.once("close", () => {
          resolve(received);
        });
        socket.once("error", () => {
          resolve(received);
        });
      });
      expect(replies).not.toContain("authenticated");
      expect(lifecycleCalls).toEqual([]);
      const projected = JSON.stringify({
        replies,
        lifecycleCalls,
        consoleOutput,
      });
      expect(projected).not.toContain(sentinel);
      expect(ingress.session.token).not.toContain(sentinel);
    } finally {
      vi.restoreAllMocks();
      await ingress.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("persists a native Question before it becomes caller-visible", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentport-ingress-"));
    const calls: string[] = [];
    const ingress = await RuntimeWorkerIngress.open({
      endpoint: join(directory, "worker.sock"),
      reference,
      lifecycle: {
        persistQuestion() {
          calls.push("question-persist");
          return Promise.resolve();
        },
        waitForAcceptedAnswer() {
          return Promise.resolve({});
        },
        acknowledgeQuestionDelivery() {
          return Promise.resolve();
        },
        markQuestionDeliveryUnknown() {
          return Promise.resolve();
        },
        recordObservation() {
          calls.push("persist");
          return Promise.resolve();
        },
        stopAfterCandidate() {
          calls.push("candidate-stop");
          return Promise.resolve();
        },
        quarantine() {
          calls.push("quarantine");
          return Promise.resolve();
        },
      },
    });
    try {
      const replies = await exchange(
        ingress.session.endpoint,
        ingress.session.token,
        [
          encodeWorkerObservation({
            kind: "question",
            reference,
            ordinal: 1,
            questionId: "question-1",
            toolUseId: "tool-1",
            requestId: "request-1",
            toolActivity: "none",
            questions: [
              {
                question: "Continue?",
                header: "Continue",
                options: [
                  { label: "Yes", description: "Continue execution" },
                  { label: "No", description: "Stop execution" },
                ],
                multiSelect: false,
              },
            ],
          }),
        ],
      );
      expect(replies).toEqual([
        { kind: "authenticated" },
        { kind: "question_persisted", ordinal: 1 },
      ]);
      expect(calls).toEqual(["question-persist"]);
    } finally {
      await ingress.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
});
