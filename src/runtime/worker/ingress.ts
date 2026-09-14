import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, chown, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";

import type {
  ExecutionReference,
  RuntimeQuestionIdentity,
} from "../../core/types.js";
import {
  MAX_WORKER_MESSAGE_BYTES,
  RuntimeWorkerObservationSequence,
  type RuntimeWorkerObservation,
} from "./protocol.js";

const MAX_INGRESS_BUFFER_BYTES = MAX_WORKER_MESSAGE_BYTES * 2;
const AUTHENTICATION_TIMEOUT_MS = 5_000;

export interface WorkerIngressSession {
  endpoint: string;
  token: string;
}

export interface RuntimeWorkerIngressLifecycle {
  persistQuestion(
    observation: Extract<RuntimeWorkerObservation, { kind: "question" }>,
  ): Promise<void>;
  waitForAcceptedAnswer(
    reference: ExecutionReference,
    identity: RuntimeQuestionIdentity,
    signal: AbortSignal,
  ): Promise<Record<string, string> | { kind: "input_timeout"; answer: null }>;
  acknowledgeQuestionDelivery(
    reference: ExecutionReference,
    identity: RuntimeQuestionIdentity,
  ): Promise<void>;
  markQuestionDeliveryUnknown(
    reference: ExecutionReference,
    identity: RuntimeQuestionIdentity,
  ): Promise<void>;
  recordObservation(
    observation:
      | {
          kind: "progress";
          reference: ExecutionReference;
          ordinal: number;
          summary: string;
        }
      | {
          kind: "candidate";
          reference: ExecutionReference;
          ordinal: number;
          finalOrdinal: number;
          outcome: {
            kind: "completed" | "failed" | "canceled";
            summary: string;
          };
          sessionReference: string | null;
        },
  ): Promise<void>;
  stopAfterCandidate(reference: ExecutionReference): Promise<void>;
  quarantine(reference: ExecutionReference): Promise<void>;
}

/**
 * A per-execution Unix socket.  It authenticates one worker, validates its
 * entire observation sequence, and keeps the worker away from lifecycle and
 * storage interfaces.  Candidate acknowledgement means persistence occurred;
 * it does not claim a terminal result.
 */
export class RuntimeWorkerIngress {
  readonly session: WorkerIngressSession;
  #server: Server | undefined;
  #closed = false;
  #connected = false;
  #authenticating = false;
  #activeSocket: Socket | undefined;

  private constructor(
    private readonly reference: ExecutionReference,
    private readonly lifecycle: RuntimeWorkerIngressLifecycle,
    endpoint: string,
    token: string,
  ) {
    this.session = Object.freeze({ endpoint, token });
  }

  static async open(options: {
    endpoint: string;
    reference: ExecutionReference;
    lifecycle: RuntimeWorkerIngressLifecycle;
    groupId?: number;
  }): Promise<RuntimeWorkerIngress> {
    const ingress = new RuntimeWorkerIngress(
      options.reference,
      options.lifecycle,
      options.endpoint,
      randomBytes(32).toString("base64url"),
    );
    await rm(options.endpoint, { force: true });
    const server = createServer((socket) => {
      ingress.#accept(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.endpoint, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(options.endpoint, 0o660);
    if (options.groupId !== undefined) {
      await chown(options.endpoint, 0, options.groupId);
    }
    ingress.#server = server;
    return ingress;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const server = this.#server;
    this.#server = undefined;
    this.#activeSocket?.destroy();
    this.#activeSocket = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
    await rm(this.session.endpoint, { force: true });
  }

  #accept(socket: Socket): void {
    if (this.#closed || this.#connected || this.#authenticating) {
      socket.destroy();
      return;
    }
    this.#authenticating = true;
    this.#activeSocket = socket;
    socket.setEncoding("utf8");
    const sequence = new RuntimeWorkerObservationSequence();
    let authenticated = false;
    let buffer = "";
    let serial = Promise.resolve();
    let persistedQuestion: RuntimeQuestionIdentity | undefined;
    let deliveredQuestion: RuntimeQuestionIdentity | undefined;
    let terminalCandidateAccepted = false;
    const deliveryAbort = new AbortController();
    const authenticationTimeout = setTimeout(() => {
      if (!authenticated) socket.destroy();
    }, AUTHENTICATION_TIMEOUT_MS);
    authenticationTimeout.unref();
    const reject = (): void => {
      socket.destroy();
      if (authenticated) {
        void this.lifecycle.quarantine(this.reference).catch(() => undefined);
      }
    };
    const acknowledge = (value: Record<string, unknown>): void => {
      socket.write(`${JSON.stringify(value)}\n`);
    };
    const acceptObservation = async (observation: RuntimeWorkerObservation) => {
      if (observation.kind === "question") {
        if (persistedQuestion !== undefined) {
          throw new Error("worker already has a pending Question");
        }
        await this.lifecycle.persistQuestion(observation);
        persistedQuestion = {
          questionId: observation.questionId,
          toolUseId: observation.toolUseId,
          requestId: observation.requestId,
        };
        acknowledge({
          kind: "question_persisted",
          ordinal: observation.ordinal,
        });
        return;
      }
      if (observation.kind === "progress") {
        await this.lifecycle.recordObservation(observation);
        acknowledge({ kind: "accepted", ordinal: observation.ordinal });
        return;
      }
      await this.lifecycle.recordObservation({
        kind: "candidate",
        reference: observation.reference,
        ordinal: observation.ordinal,
        finalOrdinal: observation.finalOrdinal,
        outcome: {
          kind:
            observation.outcome === "succeeded"
              ? "completed"
              : observation.outcome,
          summary: observation.summary,
        },
        sessionReference: observation.sessionReference,
        ...(observation.protectedSessionToken === undefined
          ? {}
          : { protectedSessionToken: observation.protectedSessionToken }),
      });
      acknowledge({
        kind: "candidate_persisted",
        ordinal: observation.ordinal,
      });
      terminalCandidateAccepted = true;
      await this.lifecycle.stopAfterCandidate(this.reference);
    };

    const acceptDeliveryControl = async (frame: string): Promise<boolean> => {
      let value: unknown;
      try {
        value = JSON.parse(frame);
      } catch {
        return false;
      }
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        typeof (value as Record<string, unknown>).kind !== "string" ||
        typeof (value as Record<string, unknown>).questionId !== "string"
      ) {
        return false;
      }
      const request = value as Record<string, unknown>;
      const identity = runtimeQuestionIdentity(request);
      if (identity === undefined) return false;
      if (
        request.kind === "await_answer" &&
        persistedQuestion !== undefined &&
        sameQuestionIdentity(persistedQuestion, identity) &&
        deliveredQuestion === undefined
      ) {
        const answer = await this.lifecycle.waitForAcceptedAnswer(
          this.reference,
          identity,
          deliveryAbort.signal,
        );
        if (
          "kind" in answer &&
          "answer" in answer &&
          answer.kind === "input_timeout" &&
          answer.answer === null
        ) {
          acknowledge({
            kind: "input_timeout",
            questionId: identity.questionId,
          });
          return true;
        }
        deliveredQuestion = identity;
        acknowledge({
          kind: "answer",
          questionId: identity.questionId,
          answer,
        });
        return true;
      }
      if (
        request.kind === "acknowledge_answer" &&
        persistedQuestion !== undefined &&
        deliveredQuestion !== undefined &&
        sameQuestionIdentity(persistedQuestion, identity) &&
        sameQuestionIdentity(deliveredQuestion, identity)
      ) {
        await this.lifecycle.acknowledgeQuestionDelivery(
          this.reference,
          identity,
        );
        persistedQuestion = undefined;
        deliveredQuestion = undefined;
        acknowledge({
          kind: "answer_acknowledged",
          questionId: identity.questionId,
        });
        return true;
      }
      return false;
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_INGRESS_BUFFER_BYTES) {
        reject();
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const frame = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        serial = serial
          .then(async () => {
            if (!authenticated) {
              let message: unknown;
              try {
                message = JSON.parse(frame);
              } catch {
                throw new Error("invalid ingress authentication");
              }
              if (
                typeof message !== "object" ||
                message === null ||
                Array.isArray(message) ||
                (message as Record<string, unknown>).kind !== "authenticate" ||
                typeof (message as Record<string, unknown>).token !==
                  "string" ||
                !sameToken(
                  (message as Record<string, unknown>).token as string,
                  this.session.token,
                )
              ) {
                throw new Error("invalid ingress authentication");
              }
              authenticated = true;
              clearTimeout(authenticationTimeout);
              this.#authenticating = false;
              this.#connected = true;
              acknowledge({ kind: "authenticated" });
              return;
            }
            if (await acceptDeliveryControl(frame)) return;
            const observation = sequence.accept(this.reference, frame);
            if (observation === undefined) {
              throw new Error("invalid worker observation");
            }
            await acceptObservation(observation);
          })
          .catch(() => {
            reject();
          });
      }
    });
    socket.once("error", () => {
      deliveryAbort.abort();
      reject();
    });
    socket.once("close", () => {
      clearTimeout(authenticationTimeout);
      deliveryAbort.abort();
      if (this.#activeSocket === socket) this.#activeSocket = undefined;
      if (!authenticated) this.#authenticating = false;
      if (authenticated && persistedQuestion !== undefined) {
        void this.lifecycle
          .markQuestionDeliveryUnknown(this.reference, persistedQuestion)
          .catch(() => undefined);
      }
      if (authenticated && !terminalCandidateAccepted) {
        void this.lifecycle.quarantine(this.reference).catch(() => undefined);
      }
    });
  }
}

function runtimeQuestionIdentity(
  value: Record<string, unknown>,
): RuntimeQuestionIdentity | undefined {
  const questionId = value.questionId;
  const toolUseId = value.toolUseId;
  const requestId = value.requestId;
  if (
    typeof questionId !== "string" ||
    typeof toolUseId !== "string" ||
    typeof requestId !== "string"
  ) {
    return undefined;
  }
  return { questionId, toolUseId, requestId };
}

function sameQuestionIdentity(
  left: RuntimeQuestionIdentity,
  right: RuntimeQuestionIdentity,
): boolean {
  return (
    left.questionId === right.questionId &&
    left.toolUseId === right.toolUseId &&
    left.requestId === right.requestId
  );
}

function sameToken(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}
