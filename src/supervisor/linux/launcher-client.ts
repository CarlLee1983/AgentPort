import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname } from "node:path";

import type { ExecutionReference } from "../../core/types.js";
import type {
  ProtectedRuntimeLaunchDirective,
  RuntimeExecutionPolicy,
  RuntimeIngressDescriptor,
} from "../../core/execution-supervisor.js";
import {
  MAX_LAUNCHER_FRAME_BYTES,
  encodeLauncherFrame,
  parseLauncherResponse,
  type LinuxLauncherExecutionAction,
  type LinuxLauncherRequest,
  type LinuxLauncherResult,
} from "./launcher-protocol.js";

export interface LinuxLauncherClientOptions {
  socketPath: string;
  timeoutMilliseconds?: number;
}

export class LinuxLauncherClient {
  readonly #socketPath: string;
  readonly #timeoutMilliseconds: number;

  constructor(options: LinuxLauncherClientOptions) {
    this.#socketPath = options.socketPath;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 5000;
  }

  async request(
    action: LinuxLauncherExecutionAction,
    reference: ExecutionReference,
    ingress?: RuntimeIngressDescriptor,
    continuation?: ProtectedRuntimeLaunchDirective,
    policy?: RuntimeExecutionPolicy,
  ): Promise<LinuxLauncherResult> {
    const result = await this.#send({
      action,
      reference,
      ...(ingress === undefined ? {} : { ingress }),
      ...(continuation === undefined ? {} : { continuation }),
      ...(policy === undefined ? {} : { policy }),
    });
    return result.kind === "dispatch_authority"
      ? { kind: "indeterminate" }
      : result;
  }

  async dispatchAuthority(): Promise<string | undefined> {
    const result = await this.#send({ action: "dispatch_authority" });
    return result.kind === "dispatch_authority"
      ? result.daemonEpoch
      : undefined;
  }

  async #send(
    requestWithoutId:
      | { action: "dispatch_authority" }
      | {
          action: LinuxLauncherExecutionAction;
          reference: ExecutionReference;
          ingress?: RuntimeIngressDescriptor;
          continuation?: ProtectedRuntimeLaunchDirective;
          policy?: RuntimeExecutionPolicy;
        },
  ): Promise<LinuxLauncherResult> {
    if (!(await this.#isProtectedSocket())) return { kind: "unavailable" };
    const requestId = randomUUID();
    const request: LinuxLauncherRequest = {
      requestId,
      ...requestWithoutId,
    };
    return new Promise((resolve) => {
      const socket = createConnection(this.#socketPath);
      let settled = false;
      let buffer = "";

      const finish = (result: LinuxLauncherResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };
      const timer = setTimeout(() => {
        finish({ kind: "indeterminate" });
      }, this.#timeoutMilliseconds);
      timer.unref();

      socket.setEncoding("utf8");
      socket.once("connect", () => {
        socket.write(encodeLauncherFrame(request));
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, "utf8") > MAX_LAUNCHER_FRAME_BYTES) {
          finish({ kind: "indeterminate" });
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = parseLauncherResponse(
            buffer.slice(0, newline),
            requestId,
          );
          finish(response?.result ?? { kind: "indeterminate" });
        } catch {
          finish({ kind: "indeterminate" });
        }
      });
      socket.once("error", () => {
        finish({ kind: "unavailable" });
      });
      socket.once("end", () => {
        finish({ kind: "indeterminate" });
      });
    });
  }

  async #isProtectedSocket(): Promise<boolean> {
    try {
      const [socket, parent] = await Promise.all([
        lstat(this.#socketPath),
        lstat(dirname(this.#socketPath)),
      ]);
      return (
        process.platform === "linux" &&
        socket.isSocket() &&
        socket.uid === 0 &&
        (socket.mode & 0o007) === 0 &&
        parent.isDirectory() &&
        !parent.isSymbolicLink() &&
        parent.uid === 0 &&
        (parent.mode & 0o022) === 0
      );
    } catch {
      return false;
    }
  }
}
