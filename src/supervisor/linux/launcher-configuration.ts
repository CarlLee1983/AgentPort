import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, parse } from "node:path";

import { z } from "zod";

import type {
  LinuxLauncherServerOptions,
  LinuxLaunchProfile,
} from "./launcher-server.js";

const MAX_CONFIGURATION_BYTES = 128 * 1024;
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value));
const boundedPositiveInteger = (maximum: number) =>
  z.number().int().positive().max(maximum);
const profileSchema = z
  .object({
    workspaceIdentity: identifier,
    workspacePath: absolutePath,
    workerEntrypoint: absolutePath,
    workerArguments: z.array(z.string().min(1).max(4096)).max(32),
    gateDelayMilliseconds: z
      .number()
      .int()
      .nonnegative()
      .max(60_000)
      .optional(),
    memoryMaxBytes: boundedPositiveInteger(17_179_869_184).optional(),
    tasksMax: boundedPositiveInteger(4096).optional(),
    cpuQuotaPercent: boundedPositiveInteger(1000).optional(),
  })
  .strict();
const configurationSchema = z
  .object({
    socketPath: absolutePath,
    socketGroup: identifier,
    ledgerDirectory: absolutePath,
    workspaceRoot: absolutePath,
    runtimeUser: identifier,
    runtimeGroup: identifier,
    runtimeHome: absolutePath,
    nodeExecutable: absolutePath,
    profiles: z
      .record(identifier, profileSchema)
      .refine((profiles) => Object.keys(profiles).length > 0),
    commandTimeoutMilliseconds: boundedPositiveInteger(60_000).optional(),
    stopTimeoutMilliseconds: boundedPositiveInteger(60_000).optional(),
  })
  .strict();

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function parseLinuxLauncherOptions(
  value: unknown,
): LinuxLauncherServerOptions {
  const parsed = configurationSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid protected launcher configuration");
  }
  const profiles: Record<string, LinuxLaunchProfile> = {};
  for (const [profileId, profile] of Object.entries(parsed.data.profiles)) {
    profiles[profileId] = {
      workspaceIdentity: profile.workspaceIdentity,
      workspacePath: profile.workspacePath,
      workerEntrypoint: profile.workerEntrypoint,
      workerArguments: profile.workerArguments,
      ...(profile.gateDelayMilliseconds === undefined
        ? {}
        : { gateDelayMilliseconds: profile.gateDelayMilliseconds }),
      ...(profile.memoryMaxBytes === undefined
        ? {}
        : { memoryMaxBytes: profile.memoryMaxBytes }),
      ...(profile.tasksMax === undefined ? {} : { tasksMax: profile.tasksMax }),
      ...(profile.cpuQuotaPercent === undefined
        ? {}
        : { cpuQuotaPercent: profile.cpuQuotaPercent }),
    };
  }
  const options: LinuxLauncherServerOptions = {
    socketPath: parsed.data.socketPath,
    socketGroup: parsed.data.socketGroup,
    ledgerDirectory: parsed.data.ledgerDirectory,
    workspaceRoot: parsed.data.workspaceRoot,
    runtimeUser: parsed.data.runtimeUser,
    runtimeGroup: parsed.data.runtimeGroup,
    runtimeHome: parsed.data.runtimeHome,
    nodeExecutable: parsed.data.nodeExecutable,
    profiles,
    ...(parsed.data.commandTimeoutMilliseconds === undefined
      ? {}
      : {
          commandTimeoutMilliseconds: parsed.data.commandTimeoutMilliseconds,
        }),
    ...(parsed.data.stopTimeoutMilliseconds === undefined
      ? {}
      : { stopTimeoutMilliseconds: parsed.data.stopTimeoutMilliseconds }),
  };
  return deepFreeze(options);
}

async function validateProtectedAncestors(path: string): Promise<void> {
  const root = parse(path).root;
  let current = dirname(path);
  while (current !== root) {
    const metadata = await lstat(current);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== 0 ||
      (metadata.mode & 0o022) !== 0
    ) {
      throw new Error("Launcher configuration path is not protected");
    }
    current = dirname(current);
  }
  const rootMetadata = await lstat(root);
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    rootMetadata.uid !== 0 ||
    (rootMetadata.mode & 0o022) !== 0
  ) {
    throw new Error("Launcher configuration path is not protected");
  }
}

export async function readProtectedLinuxLauncherOptions(
  configurationPath: string,
): Promise<LinuxLauncherServerOptions> {
  if (!isAbsolute(configurationPath)) {
    throw new Error("Launcher configuration path is not protected");
  }
  await validateProtectedAncestors(configurationPath);
  const handle = await open(
    configurationPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.uid !== 0 ||
      (metadata.mode & 0o022) !== 0 ||
      metadata.size === 0 ||
      metadata.size > MAX_CONFIGURATION_BYTES
    ) {
      throw new Error("Launcher configuration file is not protected");
    }
    let value: unknown;
    try {
      value = JSON.parse(await handle.readFile("utf8"));
    } catch {
      throw new Error("Invalid protected launcher configuration");
    }
    return parseLinuxLauncherOptions(value);
  } finally {
    await handle.close();
  }
}
