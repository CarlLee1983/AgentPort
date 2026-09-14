import { describe, expect, it } from "vitest";

import type { ExecutionReference } from "../../src/core/types.js";
import {
  isSessionReferenceFor,
  sessionReferenceFor,
} from "../../src/runtime/claude/session-reference.js";
import {
  MAX_WORKER_MESSAGE_BYTES,
  RuntimeWorkerObservationSequence,
  encodeWorkerObservation,
  projectRuntimeWorkerFailure,
} from "../../src/runtime/worker/protocol.js";

const reference: ExecutionReference = {
  executionId: "execution-ipc-1",
  generation: "generation-1",
  daemonEpoch: "epoch-1",
  launchProfileId: "profile-1",
  workspaceIdentity: "workspace-1",
};

describe("Runtime worker IPC", () => {
  it("accepts one Reference-bound contiguous observation sequence", () => {
    const sequence = new RuntimeWorkerObservationSequence();
    const progress = encodeWorkerObservation({
      kind: "progress",
      reference,
      ordinal: 1,
      summary: "started",
    });
    const question = encodeWorkerObservation({
      kind: "question",
      reference,
      ordinal: 2,
      questionId: "question-1",
      toolUseId: "tool-use-1",
      requestId: "request-1",
      toolActivity: "none",
      questions: [
        {
          question: "Choose one?",
          header: "Choice",
          options: [
            { label: "One", description: "Choose the first option" },
            { label: "Two", description: "Choose the second option" },
          ],
          multiSelect: false,
        },
      ],
    });
    const candidate = encodeWorkerObservation({
      kind: "candidate",
      reference,
      ordinal: 3,
      outcome: "succeeded",
      summary: "done",
      sessionReference: sessionReferenceFor(reference, "sdk-session-1"),
      finalOrdinal: 3,
    });

    expect(sequence.accept(reference, progress)).toMatchObject({ ordinal: 1 });
    expect(sequence.accept(reference, question)).toMatchObject({
      ordinal: 2,
      questionId: "question-1",
      toolUseId: "tool-use-1",
    });
    expect(sequence.accept(reference, candidate)).toMatchObject({
      ordinal: 3,
      finalOrdinal: 3,
    });
    expect(sequence.trusted).toBe(true);
  });

  it.each([
    [
      "wrong Reference",
      {
        reference: { ...reference, generation: "stale" },
        kind: "progress",
        ordinal: 1,
        summary: "bad",
      },
    ],
    [
      "ordinal gap",
      { reference, kind: "progress", ordinal: 2, summary: "bad" },
    ],
    [
      "unbound question",
      {
        reference,
        kind: "question",
        ordinal: 1,
        questionId: "question-1",
        prompt: "bad",
      },
    ],
    [
      "candidate mismatch",
      {
        reference,
        kind: "candidate",
        ordinal: 1,
        outcome: "succeeded",
        summary: "bad",
        sessionReference: null,
        finalOrdinal: 2,
      },
    ],
    [
      "oversized Session reference",
      {
        reference,
        kind: "candidate",
        ordinal: 1,
        outcome: "succeeded",
        summary: "bad",
        sessionReference: "s".repeat(513),
        finalOrdinal: 1,
      },
    ],
    [
      "path-shaped Session reference",
      {
        reference,
        kind: "candidate",
        ordinal: 1,
        outcome: "succeeded",
        summary: "bad",
        sessionReference:
          "/var/lib/agentport-runtime/.claude/.credentials.json",
        finalOrdinal: 1,
      },
    ],
    [
      "cross-execution Session reference",
      {
        reference: { ...reference, executionId: "execution-ipc-other" },
        kind: "candidate",
        ordinal: 1,
        outcome: "succeeded",
        summary: "bad",
        sessionReference: "session-from-other-execution",
        finalOrdinal: 1,
      },
    ],
  ])("permanently rejects a %s", (_label, value) => {
    const sequence = new RuntimeWorkerObservationSequence();
    expect(sequence.accept(reference, JSON.stringify(value))).toBeUndefined();
    expect(sequence.trusted).toBe(false);
    expect(
      sequence.accept(
        reference,
        JSON.stringify({
          reference,
          kind: "progress",
          ordinal: 1,
          summary: "cannot recover trust",
        }),
      ),
    ).toBeUndefined();
  });

  it("rejects an oversized frame without parsing it", () => {
    const sequence = new RuntimeWorkerObservationSequence();
    expect(
      sequence.accept(reference, "x".repeat(MAX_WORKER_MESSAGE_BYTES + 1)),
    ).toBeUndefined();
    expect(sequence.trusted).toBe(false);
  });

  it("permanently closes the sequence after its final candidate", () => {
    const sequence = new RuntimeWorkerObservationSequence();
    const candidate = encodeWorkerObservation({
      kind: "candidate",
      reference,
      ordinal: 1,
      outcome: "succeeded",
      summary: "done",
      sessionReference: sessionReferenceFor(reference, "sdk-session-1"),
      finalOrdinal: 1,
    });
    const lateProgress = encodeWorkerObservation({
      kind: "progress",
      reference,
      ordinal: 2,
      summary: "too late",
    });

    expect(sequence.accept(reference, candidate)).toMatchObject({
      kind: "candidate",
      finalOrdinal: 1,
    });
    expect(sequence.accept(reference, lateProgress)).toBeUndefined();
    expect(sequence.trusted).toBe(false);
  });

  it("rejects a valid-form Session reference copied from another execution", () => {
    const sequence = new RuntimeWorkerObservationSequence();
    const otherReference = {
      ...reference,
      executionId: "execution-ipc-other",
    };
    const candidate = encodeWorkerObservation({
      kind: "candidate",
      reference,
      ordinal: 1,
      outcome: "succeeded",
      summary: "done",
      sessionReference: sessionReferenceFor(otherReference, "sdk-session-1"),
      finalOrdinal: 1,
    });

    expect(sequence.accept(reference, candidate)).toBeUndefined();
    expect(sequence.trusted).toBe(false);
  });

  it("keeps distinct Runtime Sessions distinct within one execution", () => {
    const first = sessionReferenceFor(reference, "sdk-session-1");
    const second = sessionReferenceFor(reference, "sdk-session-2");

    expect(first).not.toBe(second);
    expect(isSessionReferenceFor(first, reference)).toBe(true);
    expect(isSessionReferenceFor(second, reference)).toBe(true);
  });

  it("omits credential paths and host causes from a bounded worker failure", () => {
    const credentialPath =
      "/var/lib/agentport-runtime/.claude/.credentials.json";
    const hostCause = "connect ECONNREFUSED host.internal.example";
    const failure = projectRuntimeWorkerFailure(
      new Error(`Authentication failed at ${credentialPath}`, {
        cause: new Error(hostCause),
      }),
      "claude-capability",
    );

    expect(failure).toEqual({
      kind: "candidate",
      outcome: "failed",
      summary: "claude-capability-failed",
      sessionReference: null,
    });
    const encoded = JSON.stringify(failure);
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThan(256);
    expect(encoded).not.toContain(credentialPath);
    expect(encoded).not.toContain(hostCause);
  });
});
