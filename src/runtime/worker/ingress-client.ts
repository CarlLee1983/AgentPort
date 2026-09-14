import { createConnection, type Socket } from "node:net";

import type { RuntimeQuestionIdentity } from "../../core/types.js";
import { MAX_WORKER_MESSAGE_BYTES } from "./protocol.js";

const CONNECT_TIMEOUT_MS = 5_000;

export class RuntimeInputTimeoutError extends Error {}

/** Worker-side transport only.  It has no storage, control, or terminal capability. */
export class RuntimeWorkerIngressClient {
  #socket: Socket | undefined;
  #buffer = "";
  #waiter:
    | {
        resolve(value: Record<string, unknown>): void;
        reject(reason: Error): void;
      }
    | undefined;

  private constructor() {}

  static async connect(options: {
    endpoint: string;
    token: string;
  }): Promise<RuntimeWorkerIngressClient> {
    const client = new RuntimeWorkerIngressClient();
    const socket = createConnection(options.endpoint);
    client.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      client.#receive(chunk);
    });
    socket.on("error", (error) => {
      client.#fail(error);
    });
    socket.on("end", () => {
      client.#fail(new Error("Worker ingress closed"));
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Worker ingress was unavailable"));
      }, CONNECT_TIMEOUT_MS);
      timer.unref();
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const reply = await client.#send({
      kind: "authenticate",
      token: options.token,
    });
    if (reply.kind !== "authenticated") {
      client.close();
      throw new Error("Worker ingress rejected authentication");
    }
    return client;
  }

  async emit(
    encoded: string,
    ordinal: number,
    kind: "progress" | "question" | "candidate",
  ): Promise<void> {
    if (Buffer.byteLength(encoded, "utf8") > MAX_WORKER_MESSAGE_BYTES) {
      throw new Error("Worker observation exceeds ingress bound");
    }
    const reply = await this.#sendRaw(encoded);
    const expectedKind =
      kind === "candidate"
        ? "candidate_persisted"
        : kind === "question"
          ? "question_persisted"
          : "accepted";
    if (reply.kind !== expectedKind || reply.ordinal !== ordinal) {
      throw new Error("Worker ingress rejected observation");
    }
  }

  async waitForQuestionAnswer(
    identity: RuntimeQuestionIdentity,
  ): Promise<Record<string, string>> {
    const reply = await this.#send({ kind: "await_answer", ...identity });
    if (
      reply.kind === "input_timeout" &&
      reply.questionId === identity.questionId
    ) {
      throw new RuntimeInputTimeoutError("Question input expired");
    }
    if (
      reply.kind !== "answer" ||
      reply.questionId !== identity.questionId ||
      typeof reply.answer !== "object" ||
      reply.answer === null ||
      Array.isArray(reply.answer) ||
      !Object.values(reply.answer).every((value) => typeof value === "string")
    ) {
      throw new Error("Worker ingress returned an invalid Question answer");
    }
    return { ...(reply.answer as Record<string, string>) };
  }

  async acknowledgeQuestionDelivery(
    identity: RuntimeQuestionIdentity,
  ): Promise<void> {
    const reply = await this.#send({
      kind: "acknowledge_answer",
      ...identity,
    });
    if (
      reply.kind !== "answer_acknowledged" ||
      reply.questionId !== identity.questionId
    ) {
      throw new Error("Worker ingress rejected Question acknowledgement");
    }
  }

  close(): void {
    this.#socket?.destroy();
    this.#socket = undefined;
  }

  #send(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#sendRaw(JSON.stringify(value));
  }

  #sendRaw(frame: string): Promise<Record<string, unknown>> {
    const socket = this.#socket;
    if (
      socket === undefined ||
      socket.destroyed ||
      this.#waiter !== undefined
    ) {
      return Promise.reject(new Error("Worker ingress is unavailable"));
    }
    return new Promise((resolve, reject) => {
      this.#waiter = { resolve, reject };
      socket.write(`${frame}\n`);
    });
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_WORKER_MESSAGE_BYTES) {
      this.#fail(new Error("Worker ingress response exceeded bound"));
      return;
    }
    const newline = this.#buffer.indexOf("\n");
    if (newline < 0) return;
    const frame = this.#buffer.slice(0, newline);
    this.#buffer = this.#buffer.slice(newline + 1);
    let reply: unknown;
    try {
      reply = JSON.parse(frame);
    } catch {
      this.#fail(new Error("Worker ingress response was invalid"));
      return;
    }
    if (typeof reply !== "object" || reply === null || Array.isArray(reply)) {
      this.#fail(new Error("Worker ingress response was invalid"));
      return;
    }
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.resolve(reply as Record<string, unknown>);
  }

  #fail(error: Error): void {
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.reject(error);
  }
}
