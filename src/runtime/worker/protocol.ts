import type { ExecutionReference } from "../../core/types.js";
import {
  isSessionReferenceFor,
  sessionReferenceFor,
} from "../claude/session-reference.js";
import { isProtectedClaudeSessionToken } from "../claude/session-reference.js";

export const MAX_WORKER_MESSAGE_BYTES = 64 * 1024;
const MAX_SUMMARY_BYTES = 1024;
const MAX_QUESTION_BYTES = 4096;
const MAX_CANDIDATE_BYTES = 32 * 1024;
const MAX_SESSION_REFERENCE_BYTES = 512;
const MAX_ID_CHARACTERS = 128;

export type RuntimeWorkerObservation =
  | {
      kind: "progress";
      reference: ExecutionReference;
      ordinal: number;
      summary: string;
    }
  | {
      kind: "question";
      reference: ExecutionReference;
      ordinal: number;
      questionId: string;
      toolUseId: string;
      requestId: string;
      toolActivity: "none";
      questions: readonly RuntimeWorkerQuestion[];
    }
  | {
      kind: "candidate";
      reference: ExecutionReference;
      ordinal: number;
      outcome: "succeeded" | "failed" | "canceled";
      summary: string;
      sessionReference: string | null;
      /** Raw vendor token; accepted only on the authenticated ingress path. */
      protectedSessionToken?: string;
      finalOrdinal: number;
    };

export interface RuntimeWorkerQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface RuntimeWorkerQuestion {
  question: string;
  header: string;
  options: readonly RuntimeWorkerQuestionOption[];
  multiSelect: boolean;
}

export function projectRuntimeWorkerFailure(
  _error: unknown,
  kind: "isolation-probe" | "claude-capability",
): {
  kind: "candidate";
  outcome: "failed";
  summary: "isolation-probe-failed" | "claude-capability-failed";
  sessionReference: null;
} {
  return {
    kind: "candidate",
    outcome: "failed",
    summary:
      kind === "isolation-probe"
        ? "isolation-probe-failed"
        : "claude-capability-failed",
    sessionReference: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

function boundedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_CHARACTERS &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function sameReference(
  expected: ExecutionReference,
  value: unknown,
): value is ExecutionReference {
  return (
    isRecord(value) &&
    value.executionId === expected.executionId &&
    value.generation === expected.generation &&
    value.daemonEpoch === expected.daemonEpoch &&
    value.launchProfileId === expected.launchProfileId &&
    value.workspaceIdentity === expected.workspaceIdentity
  );
}

function parseQuestions(value: unknown): RuntimeWorkerQuestion[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) {
    return undefined;
  }
  const questions: RuntimeWorkerQuestion[] = [];
  for (const candidate of value as unknown[]) {
    if (!isRecord(candidate)) return undefined;
    const question = candidate["question"];
    const header = candidate["header"];
    const options = candidate["options"];
    const multiSelect = candidate["multiSelect"];
    if (
      !boundedString(question, MAX_QUESTION_BYTES) ||
      questions.some((existing) => existing.question === question) ||
      typeof header !== "string" ||
      header.length === 0 ||
      header.length > 12 ||
      !Array.isArray(options) ||
      options.length < 2 ||
      options.length > 4 ||
      typeof multiSelect !== "boolean"
    ) {
      return undefined;
    }
    const normalizedOptions: RuntimeWorkerQuestionOption[] = [];
    for (const option of options as unknown[]) {
      if (!isRecord(option)) return undefined;
      const label = option["label"];
      const description = option["description"];
      const preview = option["preview"];
      if (
        !boundedString(label, 128) ||
        normalizedOptions.some((existing) => existing.label === label) ||
        !boundedString(description, 1024) ||
        !(
          preview === undefined ||
          (typeof preview === "string" &&
            Buffer.byteLength(preview, "utf8") <= MAX_QUESTION_BYTES)
        )
      ) {
        return undefined;
      }
      normalizedOptions.push({
        label,
        description,
        ...(preview === undefined ? {} : { preview }),
      });
    }
    questions.push({
      question,
      header,
      options: normalizedOptions,
      multiSelect,
    });
  }
  return Buffer.byteLength(JSON.stringify(questions), "utf8") <=
    MAX_CANDIDATE_BYTES
    ? questions
    : undefined;
}

function parseCandidate(
  reference: ExecutionReference,
  value: Record<string, unknown>,
  ordinal: number,
): RuntimeWorkerObservation | undefined {
  if (
    value.kind !== "candidate" ||
    !["succeeded", "failed", "canceled"].includes(String(value.outcome)) ||
    !boundedString(value.summary, MAX_CANDIDATE_BYTES) ||
    !Number.isSafeInteger(value.finalOrdinal) ||
    value.finalOrdinal !== ordinal ||
    !(
      value.sessionReference === null ||
      (boundedString(value.sessionReference, MAX_SESSION_REFERENCE_BYTES) &&
        isSessionReferenceFor(value.sessionReference, reference))
    ) ||
    !(
      value.protectedSessionToken === undefined ||
      (value.outcome === "succeeded" &&
        typeof value.sessionReference === "string" &&
        isProtectedClaudeSessionToken(value.protectedSessionToken) &&
        value.sessionReference ===
          // The opaque reference is cryptographically bound to the raw token.
          // `sessionReferenceFor` stays deliberately outside every public type.
          sessionReferenceFor(reference, value.protectedSessionToken))
    )
  ) {
    return undefined;
  }
  return {
    kind: "candidate",
    reference,
    ordinal,
    outcome: value.outcome as "succeeded" | "failed" | "canceled",
    summary: value.summary,
    sessionReference: value.sessionReference,
    ...(value.protectedSessionToken === undefined
      ? {}
      : { protectedSessionToken: value.protectedSessionToken }),
    finalOrdinal: ordinal,
  };
}

/**
 * Stateful decoder for the bounded, newline-delimited worker channel.
 * A sequence is permanently rejected after a malformed or non-contiguous frame.
 */
export class RuntimeWorkerObservationSequence {
  #nextOrdinal = 1;
  #candidateAccepted = false;
  #trusted = true;

  get trusted(): boolean {
    return this.#trusted;
  }

  accept(
    reference: ExecutionReference,
    encoded: string,
  ): RuntimeWorkerObservation | undefined {
    if (
      !this.#trusted ||
      this.#candidateAccepted ||
      Buffer.byteLength(encoded, "utf8") > MAX_WORKER_MESSAGE_BYTES
    ) {
      this.#trusted = false;
      return undefined;
    }

    let value: unknown;
    try {
      value = JSON.parse(encoded);
    } catch {
      this.#trusted = false;
      return undefined;
    }
    if (
      !isRecord(value) ||
      !sameReference(reference, value.reference) ||
      !Number.isSafeInteger(value.ordinal) ||
      value.ordinal !== this.#nextOrdinal
    ) {
      this.#trusted = false;
      return undefined;
    }

    const ordinal = value.ordinal;
    let observation: RuntimeWorkerObservation | undefined;
    if (
      value.kind === "progress" &&
      boundedString(value.summary, MAX_SUMMARY_BYTES)
    ) {
      observation = {
        kind: "progress",
        reference,
        ordinal,
        summary: value.summary,
      };
    } else if (
      value.kind === "question" &&
      boundedIdentifier(value.questionId) &&
      boundedIdentifier(value.toolUseId) &&
      boundedIdentifier(value.requestId) &&
      value.toolActivity === "none"
    ) {
      const questions = parseQuestions(value.questions);
      if (questions !== undefined) {
        observation = {
          kind: "question",
          reference,
          ordinal,
          questionId: value.questionId,
          toolUseId: value.toolUseId,
          requestId: value.requestId,
          toolActivity: "none",
          questions,
        };
      }
    } else {
      observation = parseCandidate(reference, value, ordinal);
    }

    if (observation === undefined) {
      this.#trusted = false;
      return undefined;
    }
    if (observation.kind === "candidate") this.#candidateAccepted = true;
    this.#nextOrdinal += 1;
    return observation;
  }
}

export function encodeWorkerObservation(
  observation: RuntimeWorkerObservation,
): string {
  const encoded = JSON.stringify(observation);
  if (Buffer.byteLength(encoded, "utf8") > MAX_WORKER_MESSAGE_BYTES) {
    throw new Error("Worker observation exceeds the protocol bound");
  }
  return encoded;
}
