import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize, parse } from "node:path";

import { z } from "zod";

import type {
  AgentConfiguration,
  PrincipalConfiguration,
} from "../bootstrap/registry.js";
import type { DurableAdmissionStoreOptions } from "../storage/sqlite-durable-admission-store.js";

const MAX_CONFIGURATION_BYTES = 128 * 1024;
const DEFAULT_MCP_PORT = 3333;

export const DAEMON_CONFIGURATION_ERROR = "daemon_configuration_invalid";

/** An intentionally detail-free startup error safe for stderr projection. */
export class DaemonConfigurationError extends Error {
  readonly code = DAEMON_CONFIGURATION_ERROR;

  constructor() {
    super(DAEMON_CONFIGURATION_ERROR);
    this.name = "DaemonConfigurationError";
  }
}

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const boundedText = z.string().min(1).max(4096);
const absolutePath = boundedText.refine(
  (value) => isAbsolute(value) && normalize(value) === value,
);
const positiveInteger = z.number().int().positive();
const storageSchema = z
  .object({
    databasePath: absolutePath,
    recoveryOnly: z.boolean().optional(),
    auditCapacity: positiveInteger.optional(),
    activeExecutionCapacity: positiveInteger.optional(),
    queuePerWorkspace: positiveInteger.optional(),
    queueGlobal: positiveInteger.optional(),
    receiptCapacity: positiveInteger.optional(),
    admissionBytes: positiveInteger.optional(),
    physicalAdmissionBytes: positiveInteger.optional(),
    physicalControlReserveBytes: positiveInteger.optional(),
    taskControlReserveBytes: positiveInteger.optional(),
    controlReceiptReserve: positiveInteger.optional(),
    controlEventReserve: positiveInteger.optional(),
    terminalRetentionDays: positiveInteger.optional(),
    retentionSweepIntervalMs: positiveInteger.optional(),
    busyTimeoutMs: positiveInteger.optional(),
    requestTimeoutMs: positiveInteger.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.controlEventReserve !== undefined &&
      value.controlEventReserve < 2
    ) {
      context.addIssue({ code: "custom", message: "invalid storage" });
    }
    if (
      value.controlReceiptReserve !== undefined &&
      value.controlReceiptReserve < 2
    ) {
      context.addIssue({ code: "custom", message: "invalid storage" });
    }
    const queueGlobal = value.queueGlobal ?? 256;
    const controlReserve =
      value.physicalControlReserveBytes ?? 256 * 1024 * 1024;
    const taskReserve = value.taskControlReserveBytes ?? 128 * 1024;
    const admission = value.physicalAdmissionBytes ?? 2 * 1024 * 1024 * 1024;
    if (
      taskReserve < 128 * 1024 ||
      !Number.isSafeInteger(admission + controlReserve) ||
      !Number.isSafeInteger(taskReserve * queueGlobal) ||
      taskReserve * queueGlobal > controlReserve
    ) {
      context.addIssue({ code: "custom", message: "invalid storage" });
    }
  });

const agentSchema = z
  .object({
    agentId: identifier,
    description: z.string().max(8 * 1024),
    workspacePath: absolutePath,
    configurationRevision: boundedText,
    runtimeDriver: boundedText,
    runtimeVersion: boundedText,
    launchProfileId: identifier,
    policy: z
      .object({
        maximumExecutionLimitSeconds: positiveInteger,
        maximumInputWaitSeconds: positiveInteger,
      })
      .strict(),
  })
  .strict();
const principalSchema = z
  .object({
    principalId: identifier,
    accessScopeId: identifier,
    active: z.boolean(),
    allowedAgentIds: z.array(identifier).max(1024),
  })
  .strict();

const configurationSchema = z
  .object({
    schemaVersion: z.literal(1),
    mcp: z
      .object({ port: z.number().int().min(1).max(65_535).optional() })
      .strict(),
    storage: storageSchema,
    launcher: z
      .object({
        socketPath: absolutePath,
        workerIngressDirectory: absolutePath,
        runtimeGroupId: positiveInteger,
        ingressGroupId: positiveInteger,
      })
      .strict()
      .refine((value) => value.runtimeGroupId !== value.ingressGroupId),
    agents: z.array(agentSchema).max(1024),
    principals: z.array(principalSchema).max(1024),
  })
  .strict()
  .superRefine((value, context) => {
    const agentIds = new Set<string>();
    for (const agent of value.agents) {
      if (
        agentIds.has(agent.agentId) ||
        Buffer.byteLength(agent.description, "utf8") > 8 * 1024
      ) {
        context.addIssue({ code: "custom", message: "invalid agent mapping" });
      }
      agentIds.add(agent.agentId);
    }
    const principalIds = new Set<string>();
    for (const principal of value.principals) {
      if (principalIds.has(principal.principalId)) {
        context.addIssue({
          code: "custom",
          message: "invalid principal mapping",
        });
      }
      principalIds.add(principal.principalId);
      if (principal.allowedAgentIds.some((agentId) => !agentIds.has(agentId))) {
        context.addIssue({
          code: "custom",
          message: "invalid principal mapping",
        });
      }
    }
  });

export interface DaemonConfiguration {
  mcp: { port: number };
  storage: DurableAdmissionStoreOptions;
  launcher: {
    socketPath: string;
    workerIngressDirectory: string;
    runtimeGroupId: number;
    ingressGroupId: number;
  };
  agents: readonly AgentConfiguration[];
  principals: readonly PrincipalConfiguration[];
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

/** Parses only the versioned, secret-free production configuration shape. */
export function parseDaemonConfiguration(value: unknown): DaemonConfiguration {
  const parsed = configurationSchema.safeParse(value);
  if (!parsed.success) throw new DaemonConfigurationError();
  const agents = parsed.data.agents.map((agent) => ({
    ...agent,
    policy: { ...agent.policy },
  }));
  const principals = parsed.data.principals.map((principal) => ({
    ...principal,
    allowedAgentIds: [...principal.allowedAgentIds],
  }));
  return freeze({
    mcp: { port: parsed.data.mcp.port ?? DEFAULT_MCP_PORT },
    // Zod's optional-output type includes explicit `undefined`; the strict
    // schema above has already established the store option contract.
    storage: { ...parsed.data.storage } as DurableAdmissionStoreOptions,
    launcher: { ...parsed.data.launcher },
    agents,
    principals,
  });
}

async function validateProtectedAncestors(
  configurationPath: string,
): Promise<void> {
  const root = parse(configurationPath).root;
  for (let current = dirname(configurationPath); ; current = dirname(current)) {
    const metadata = await lstat(current);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== 0 ||
      (metadata.mode & 0o022) !== 0
    ) {
      throw new DaemonConfigurationError();
    }
    if (current === root) return;
  }
}

/**
 * Reads a root-owned daemon configuration without following its final path.
 * Its group may grant the non-root daemon read access, but it may never write.
 */
export async function readProtectedDaemonConfiguration(
  configurationPath: string,
): Promise<DaemonConfiguration> {
  try {
    if (
      !isAbsolute(configurationPath) ||
      normalize(configurationPath) !== configurationPath ||
      basename(configurationPath) !== "agentport.json"
    ) {
      throw new DaemonConfigurationError();
    }
    await validateProtectedAncestors(configurationPath);
    const handle = await open(
      configurationPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const metadata = await handle.stat();
      const daemonGroupId = process.getgid?.();
      if (
        !metadata.isFile() ||
        metadata.uid !== 0 ||
        daemonGroupId === undefined ||
        metadata.gid !== daemonGroupId ||
        (metadata.mode & 0o777) !== 0o640 ||
        metadata.size === 0 ||
        metadata.size > MAX_CONFIGURATION_BYTES
      ) {
        throw new DaemonConfigurationError();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await handle.readFile("utf8"));
      } catch {
        throw new DaemonConfigurationError();
      }
      return parseDaemonConfiguration(parsed);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof DaemonConfigurationError) throw error;
    throw new DaemonConfigurationError();
  }
}
