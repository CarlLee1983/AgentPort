import { chmod, chown, lstat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";

import type { DeploymentReadinessSnapshot } from "./deployment-readiness.js";

export const ADMIN_SOCKET_PATH = "/run/agentport/admin.sock";
const MAX_ADMIN_FRAME_BYTES = 4096;
const ADMIN_IDLE_TIMEOUT_MS = 2000;

export interface AdminReadinessServer {
  stopAccepting(): void;
  close(): Promise<void>;
  forceClose(): void;
}

export class AdminReadinessServerError extends Error {
  constructor() {
    super("admin_socket_unavailable");
    this.name = "AdminReadinessServerError";
  }
}

function encode(value: object): string {
  return `${JSON.stringify(value)}\n`;
}

function response(snapshot: DeploymentReadinessSnapshot): string {
  return encode({ version: 1, ok: true, readiness: snapshot });
}

function rejection(
  code: "admin_request_invalid" | "admin_request_too_large",
): string {
  return encode({ version: 1, ok: false, code });
}

function validRequest(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 2 &&
    (value as { version?: unknown }).version === 1 &&
    (value as { method?: unknown }).method === "get_readiness"
  );
}

async function validateSharedParent(
  socketPath: string,
  adminGroupId: number,
): Promise<void> {
  if (socketPath !== ADMIN_SOCKET_PATH) return;
  const parent = dirname(socketPath);
  const [directory, launcher] = await Promise.all([
    lstat(parent),
    lstat(join(parent, "launcher.sock")),
  ]);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== 0 ||
    directory.gid !== (process.getgid?.() ?? -1) ||
    (directory.mode & 0o7777) !== 0o1771 ||
    !launcher.isSocket() ||
    launcher.uid !== 0 ||
    launcher.gid === adminGroupId ||
    (launcher.mode & 0o777) !== 0o660
  ) {
    throw new Error("unsafe shared administrator socket parent");
  }
}

async function removeVerifiedStaleSocket(
  socketPath: string,
  groupId: number,
): Promise<void> {
  try {
    const metadata = await lstat(socketPath);
    if (
      !metadata.isSocket() ||
      metadata.uid !== (process.getuid?.() ?? -1) ||
      metadata.gid !== groupId ||
      (metadata.mode & 0o777) !== 0o660
    ) {
      throw new Error("unsafe stale administrator socket");
    }
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Starts the Gate-approved one-request JSON-Lines administrator interface. */
export async function startAdminReadinessServer(options: {
  socketPath?: string;
  groupId: number;
  readiness():
    DeploymentReadinessSnapshot | Promise<DeploymentReadinessSnapshot>;
}): Promise<AdminReadinessServer> {
  const socketPath = options.socketPath ?? ADMIN_SOCKET_PATH;
  const sockets = new Set<Socket>();
  let accepting = true;
  // Clients half-close after their one JSON-Lines request. Keep the writable
  // side open until the asynchronous readiness observation has been encoded.
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    if (!accepting) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(ADMIN_IDLE_TIMEOUT_MS, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_ADMIN_FRAME_BYTES) {
        socket.end(rejection("admin_request_too_large"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      if (buffer.length !== newline + 1) {
        socket.end(rejection("admin_request_invalid"));
        return;
      }
      let request: unknown;
      try {
        request = JSON.parse(buffer.slice(0, newline));
      } catch {
        socket.end(rejection("admin_request_invalid"));
        return;
      }
      if (!validRequest(request)) {
        socket.end(rejection("admin_request_invalid"));
        return;
      }
      void Promise.resolve()
        .then(() => options.readiness())
        .then((snapshot) => socket.end(response(snapshot)))
        .catch(() => socket.end(rejection("admin_request_invalid")));
    });
  });
  try {
    await validateSharedParent(socketPath, options.groupId);
    await removeVerifiedStaleSocket(socketPath, options.groupId);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chown(socketPath, process.getuid?.() ?? -1, options.groupId);
    await chmod(socketPath, 0o660);
    const metadata = await lstat(socketPath);
    if (
      !metadata.isSocket() ||
      metadata.uid !== (process.getuid?.() ?? -1) ||
      metadata.gid !== options.groupId ||
      (metadata.mode & 0o777) !== 0o660
    ) {
      throw new Error("unsafe admin socket metadata");
    }
  } catch {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    throw new AdminReadinessServerError();
  }
  return {
    stopAccepting: () => {
      accepting = false;
      for (const socket of sockets) socket.destroy();
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
    forceClose: () => {
      accepting = false;
      for (const socket of sockets) socket.destroy();
      void new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
