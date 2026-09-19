import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
} from "node:path";
import { TextDecoder } from "node:util";

export const DAEMON_CREDENTIAL_ERROR = "daemon_credentials_invalid";

/** An intentionally detail-free startup error safe for stderr projection. */
export class DaemonCredentialError extends Error {
  readonly code = DAEMON_CREDENTIAL_ERROR;

  constructor() {
    super(DAEMON_CREDENTIAL_ERROR);
    this.name = "DaemonCredentialError";
  }
}

export interface DaemonCredentials {
  cursorSecret: string;
  continuationEncryptionKey: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function isContained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

async function validateAncestors(
  directory: string,
  owner: number,
): Promise<void> {
  const root = parse(directory).root;
  for (let current = directory; ; current = dirname(current)) {
    const metadata = await lstat(current);
    const ownerAllowed = metadata.uid === 0 || metadata.uid === owner;
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !ownerAllowed ||
      (metadata.mode & 0o022) !== 0 ||
      (current === directory && (metadata.mode & 0o077) !== 0)
    ) {
      throw new DaemonCredentialError();
    }
    if (current === root) return;
  }
}

async function readCredential(
  directory: string,
  name: "cursorSecret" | "continuationEncryptionKey",
  owner: number,
): Promise<string> {
  const path = join(directory, name);
  if (!isContained(directory, path)) throw new DaemonCredentialError();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.uid !== 0 && metadata.uid !== owner) ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size === 0 ||
      metadata.size > 4096
    ) {
      throw new DaemonCredentialError();
    }
    return decoder.decode(await handle.readFile());
  } finally {
    await handle.close();
  }
}

/** Applies the existing cursor and continuation codec contracts without I/O. */
export function validateDaemonCredentials(
  cursorSecret: string,
  continuationEncryptionKey: string,
): DaemonCredentials {
  if (
    cursorSecret.length < 16 ||
    !/^[A-Za-z0-9_-]{43}$/u.test(continuationEncryptionKey) ||
    Buffer.from(continuationEncryptionKey, "base64url").byteLength !== 32
  ) {
    throw new DaemonCredentialError();
  }
  return Object.freeze({ cursorSecret, continuationEncryptionKey });
}

/** Loads fixed systemd credential files; the directory path is not a secret. */
export async function readSystemdDaemonCredentials(
  credentialsDirectory = process.env.CREDENTIALS_DIRECTORY,
): Promise<DaemonCredentials> {
  try {
    const owner = process.getuid?.();
    if (
      owner === undefined ||
      owner === 0 ||
      credentialsDirectory === undefined ||
      !isAbsolute(credentialsDirectory) ||
      normalize(credentialsDirectory) !== credentialsDirectory
    ) {
      throw new DaemonCredentialError();
    }
    await validateAncestors(credentialsDirectory, owner);
    const [cursorSecret, continuationEncryptionKey] = await Promise.all([
      readCredential(credentialsDirectory, "cursorSecret", owner),
      readCredential(credentialsDirectory, "continuationEncryptionKey", owner),
    ]);
    return validateDaemonCredentials(cursorSecret, continuationEncryptionKey);
  } catch (error) {
    if (error instanceof DaemonCredentialError) throw error;
    throw new DaemonCredentialError();
  }
}
