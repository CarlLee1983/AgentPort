import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  chown,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

import type { ExecutionReference } from "../../core/types.js";
import type {
  ProtectedRuntimeLaunchDirective,
  RuntimeExecutionPolicy,
  RuntimeIngressDescriptor,
} from "../../core/execution-supervisor.js";
import {
  encodeLauncherFrame,
  executionLedgerKey,
  executionUnitNames,
  isExecutionReference,
  MAX_LAUNCHER_FRAME_BYTES,
  parseLauncherRequest,
  type LinuxLauncherRequest,
  type LinuxLauncherResponse,
  type LinuxLauncherResult,
} from "./launcher-protocol.js";
import {
  ensureLauncherIngressDirectory,
  INGRESS_DIRECTORY_MODE,
  lstatIngressPath,
  observeIngressDirectory,
} from "./ingress-directory.js";
import { prepareProtectedLauncherDirectory } from "./protected-path.js";

const executeFile = promisify(execFile);
const RUNTIME_CREDENTIAL_NAME = "agentport-runtime";

export interface LinuxLaunchProfile {
  /** `filesystem` derives the same canonical dev:inode identity as AgentRegistry. */
  workspaceIdentity: string;
  workspacePath: string;
  workerEntrypoint: string;
  workerArguments: readonly string[];
  gateDelayMilliseconds?: number;
  memoryMaxBytes?: number;
  tasksMax?: number;
  cpuQuotaPercent?: number;
}

export interface LinuxLauncherServerOptions {
  socketPath: string;
  socketGroup: string;
  ledgerDirectory: string;
  workspaceRoot: string;
  runtimeUser: string;
  runtimeGroup: string;
  runtimeHome: string;
  nodeExecutable: string;
  ingressDirectory: string;
  ingressGroup: string;
  profiles: Readonly<Record<string, LinuxLaunchProfile>>;
  commandTimeoutMilliseconds?: number;
  stopTimeoutMilliseconds?: number;
}

export interface LinuxLedgerRecord {
  version: 1;
  reference: ExecutionReference;
  executionUnitId: string;
  serviceUnit: string;
  state: "authorized" | "sealed";
  releasedAt: string | null;
  generationSealedAt: string | null;
  unitEmptyObservedAt: string | null;
}

type LedgerRecord = LinuxLedgerRecord;

function sameReference(
  left: ExecutionReference,
  right: ExecutionReference,
): boolean {
  return (
    left.executionId === right.executionId &&
    left.generation === right.generation &&
    left.daemonEpoch === right.daemonEpoch &&
    left.launchProfileId === right.launchProfileId &&
    left.workspaceIdentity === right.workspaceIdentity
  );
}

export function isPrivilegeSeparatedRuntimeIdentity(
  runtimeUserId: number,
  runtimeGroupId: number,
  socketGroupId: number,
  supplementaryGroups: readonly number[],
): boolean {
  return (
    runtimeUserId !== 0 &&
    runtimeGroupId !== 0 &&
    runtimeGroupId !== socketGroupId &&
    supplementaryGroups.length === 1 &&
    supplementaryGroups[0] === runtimeGroupId
  );
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function now(): string {
  return new Date().toISOString();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

export function parseLinuxLedgerRecord(
  value: unknown,
  expectedExecutionId?: string,
): LinuxLedgerRecord | undefined {
  if (!isRecord(value) || !isExecutionReference(value["reference"])) {
    return undefined;
  }
  const reference = value["reference"];
  const units = executionUnitNames(reference.executionId);
  const releasedAt = value["releasedAt"];
  const generationSealedAt = value["generationSealedAt"];
  const unitEmptyObservedAt = value["unitEmptyObservedAt"];
  const validTimestampOrNull = (candidate: unknown): boolean =>
    candidate === null || isTimestamp(candidate);
  if (
    value["version"] !== 1 ||
    (expectedExecutionId !== undefined &&
      reference.executionId !== expectedExecutionId) ||
    value["executionUnitId"] !== units.executionUnitId ||
    value["serviceUnit"] !== units.serviceUnit ||
    !["authorized", "sealed"].includes(String(value["state"])) ||
    !validTimestampOrNull(releasedAt) ||
    !validTimestampOrNull(generationSealedAt) ||
    !validTimestampOrNull(unitEmptyObservedAt) ||
    (value["state"] === "authorized" &&
      (generationSealedAt !== null || unitEmptyObservedAt !== null)) ||
    (value["state"] === "sealed" && !isTimestamp(generationSealedAt)) ||
    (isTimestamp(unitEmptyObservedAt) &&
      isTimestamp(generationSealedAt) &&
      Date.parse(unitEmptyObservedAt) < Date.parse(generationSealedAt))
  ) {
    return undefined;
  }
  return {
    version: 1,
    reference,
    executionUnitId: units.executionUnitId,
    serviceUnit: units.serviceUnit,
    state: value["state"] as LedgerRecord["state"],
    releasedAt: releasedAt as string | null,
    generationSealedAt: generationSealedAt as string | null,
    unitEmptyObservedAt: unitEmptyObservedAt as string | null,
  };
}

export class LinuxLauncherServer {
  readonly #commandTimeoutMilliseconds: number;
  readonly #stopTimeoutMilliseconds: number;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #canonicalProfiles = new Map<
    string,
    {
      workspacePath: string;
      workspaceIdentity: string;
      workerEntrypoint: string;
    }
  >();
  #canonicalWorkspaceRoot: string | undefined;
  #canonicalNodeExecutable: string | undefined;
  #canonicalRuntimeHome: string | undefined;
  #dispatchAuthorityEpoch: string | undefined;
  #runtimeUserId: number | undefined;
  #runtimeGroupId: number | undefined;
  #acceptingStarts = false;
  #server: Server | undefined;

  constructor(private readonly options: LinuxLauncherServerOptions) {
    this.#commandTimeoutMilliseconds =
      options.commandTimeoutMilliseconds ?? 5000;
    this.#stopTimeoutMilliseconds = options.stopTimeoutMilliseconds ?? 5000;
  }

  async listen(): Promise<void> {
    if (this.#server !== undefined) throw new Error("Launcher is already open");
    await this.#validateConfiguration();
    await prepareProtectedLauncherDirectory(
      this.options.ledgerDirectory,
      0o700,
      0,
    );
    const socketGroupId = await this.#groupId(this.options.socketGroup);
    const socketDirectory = dirname(this.options.socketPath);
    if (socketDirectory === "/run/agentport") {
      // GATE-056: root retains the shared parent; the sticky bit prevents the
      // daemon from replacing the root-owned launcher socket.
      const daemonGroupId = await this.#groupId("agentport-daemon");
      await prepareProtectedLauncherDirectory(
        socketDirectory,
        0o1771,
        daemonGroupId,
      );
      const metadata = await lstat(socketDirectory);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        metadata.uid !== 0 ||
        metadata.gid !== daemonGroupId ||
        (metadata.mode & 0o7777) !== 0o1771
      ) {
        throw new Error("Shared launcher directory is unsafe");
      }
    } else {
      await prepareProtectedLauncherDirectory(
        socketDirectory,
        0o750,
        socketGroupId,
      );
    }
    await this.#prepareIngressDirectory(socketGroupId);
    this.#dispatchAuthorityEpoch = `epoch-${randomUUID()}`;
    const recordedUnits = await this.#sealPriorLauncherEpoch();
    await this.#sealUnitOnlyOrphans(recordedUnits);
    await this.#removeStaleSocket();

    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, "utf8") > MAX_LAUNCHER_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = parseLauncherRequest(buffer.slice(0, newline));
        if (request === undefined) {
          socket.destroy();
          return;
        }
        socket.pause();
        void this.#handle(request)
          .then((result) => {
            const response: LinuxLauncherResponse = {
              requestId: request.requestId,
              result,
            };
            socket.end(encodeLauncherFrame(response));
          })
          .catch(() => {
            const response: LinuxLauncherResponse = {
              requestId: request.requestId,
              result: { kind: "unavailable" },
            };
            socket.end(encodeLauncherFrame(response));
          });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(this.options.socketPath, 0o660);
    await chown(this.options.socketPath, 0, socketGroupId);
    this.#server = server;
    this.#acceptingStarts = true;
  }

  async close(): Promise<void> {
    this.#acceptingStarts = false;
    this.#dispatchAuthorityEpoch = undefined;
    const server = this.#server;
    this.#server = undefined;
    const recordedUnits = await this.#sealPriorLauncherEpoch();
    await this.#sealUnitOnlyOrphans(recordedUnits);
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
    await this.#removeStaleSocket();
  }

  async #handle(request: LinuxLauncherRequest): Promise<LinuxLauncherResult> {
    if (request.action === "dispatch_authority") {
      return this.#acceptingStarts && this.#dispatchAuthorityEpoch !== undefined
        ? {
            kind: "dispatch_authority",
            daemonEpoch: this.#dispatchAuthorityEpoch,
          }
        : { kind: "unavailable" };
    }
    if (request.action === "start") {
      return this.#start(
        request.reference,
        request.ingress,
        request.continuation,
        request.policy,
      );
    }
    if (request.action === "revoke_and_stop") {
      return this.#revokeAndStop(request.reference);
    }
    return this.#reconcile(request.reference);
  }

  async #start(
    reference: ExecutionReference,
    ingress?: RuntimeIngressDescriptor,
    continuation?: ProtectedRuntimeLaunchDirective,
    policy?: RuntimeExecutionPolicy,
  ): Promise<LinuxLauncherResult> {
    if (reference.daemonEpoch !== this.#dispatchAuthorityEpoch) {
      return { kind: "conflict" };
    }
    let profile: LinuxLaunchProfile;
    try {
      profile = await this.#validatedProfile(reference);
    } catch {
      return { kind: "conflict" };
    }

    const prepared = await this.#withLock<LinuxLauncherResult | undefined>(
      reference.executionId,
      async () => {
        const existing = await this.#readRecord(reference.executionId);
        if (!this.#acceptingStarts) {
          return this.#fenceRejectedStart(reference, existing);
        }
        if (reference.daemonEpoch !== this.#dispatchAuthorityEpoch) {
          return { kind: "conflict" };
        }
        if (
          existing !== undefined &&
          !sameReference(existing.reference, reference)
        ) {
          return { kind: "conflict" };
        }
        if (existing?.state === "sealed") {
          return { kind: "pending" };
        }
        if (existing?.releasedAt !== null && existing !== undefined) {
          return (await this.#unitActive(existing.serviceUnit))
            ? {
                kind: "started",
                executionUnitId: existing.executionUnitId,
              }
            : { kind: "indeterminate" };
        }
        if (existing === undefined) {
          const units = executionUnitNames(reference.executionId);
          await this.#writeRecord({
            version: 1,
            reference,
            ...units,
            state: "authorized",
            releasedAt: null,
            generationSealedAt: null,
            unitEmptyObservedAt: null,
          });
        }
        return undefined;
      },
    );
    if (prepared !== undefined) return prepared;

    if (profile.gateDelayMilliseconds !== undefined) {
      await sleep(profile.gateDelayMilliseconds);
    }

    return this.#withLock(reference.executionId, async () => {
      const record = await this.#readRecord(reference.executionId);
      if (record === undefined) return { kind: "indeterminate" };
      if (!sameReference(record.reference, reference))
        return { kind: "conflict" };
      if (!this.#acceptingStarts) {
        return this.#fenceRejectedStart(reference, record);
      }
      if (reference.daemonEpoch !== this.#dispatchAuthorityEpoch) {
        return { kind: "conflict" };
      }
      if (record.state === "sealed") return { kind: "pending" };
      if (record.releasedAt !== null) {
        return (await this.#unitActive(record.serviceUnit))
          ? { kind: "started", executionUnitId: record.executionUnitId }
          : { kind: "indeterminate" };
      }

      try {
        profile = await this.#validatedProfile(reference);
      } catch {
        return { kind: "conflict" };
      }
      await this.#startUnit(record, profile, ingress, continuation, policy);
      record.releasedAt = now();
      await this.#writeRecord(record);
      return { kind: "started", executionUnitId: record.executionUnitId };
    });
  }

  async #fenceRejectedStart(
    reference: ExecutionReference,
    existing: LedgerRecord | undefined,
  ): Promise<LinuxLauncherResult> {
    if (
      existing !== undefined &&
      !sameReference(existing.reference, reference)
    ) {
      return (await this.#sealAndStop(existing)) === undefined
        ? { kind: "indeterminate" }
        : { kind: "conflict" };
    }
    const record: LedgerRecord = existing ?? {
      version: 1,
      reference,
      ...executionUnitNames(reference.executionId),
      state: "sealed",
      releasedAt: null,
      generationSealedAt: now(),
      unitEmptyObservedAt: null,
    };
    return (await this.#sealAndStop(record)) === undefined
      ? { kind: "indeterminate" }
      : { kind: "pending" };
  }

  async #revokeAndStop(
    reference: ExecutionReference,
  ): Promise<LinuxLauncherResult> {
    return this.#withLock(reference.executionId, async () => {
      const existing = await this.#readRecord(reference.executionId);
      if (
        existing !== undefined &&
        !sameReference(existing.reference, reference)
      ) {
        return (await this.#sealAndStop(existing)) === undefined
          ? { kind: "indeterminate" }
          : { kind: "conflict" };
      }
      return this.#revokeAndStopUnlocked(reference, existing);
    });
  }

  async #reconcile(
    reference: ExecutionReference,
  ): Promise<LinuxLauncherResult> {
    return this.#withLock(reference.executionId, async () => {
      const existing = await this.#readRecord(reference.executionId);
      if (
        existing !== undefined &&
        !sameReference(existing.reference, reference)
      ) {
        return (await this.#sealAndStop(existing)) === undefined
          ? { kind: "indeterminate" }
          : { kind: "conflict" };
      }
      const units = executionUnitNames(reference.executionId);
      if (
        existing === undefined &&
        !(await this.#unitActive(units.executionUnitId)) &&
        !(await this.#unitKnown(units.serviceUnit))
      ) {
        return { kind: "indeterminate" };
      }
      return this.#revokeAndStopUnlocked(reference, existing);
    });
  }

  async #revokeAndStopUnlocked(
    reference: ExecutionReference,
    existing: LedgerRecord | undefined,
  ): Promise<LinuxLauncherResult> {
    const record: LedgerRecord = existing ?? {
      version: 1,
      reference,
      ...executionUnitNames(reference.executionId),
      state: "sealed",
      releasedAt: null,
      generationSealedAt: now(),
      unitEmptyObservedAt: null,
    };
    const observedAt = await this.#sealAndStop(record);
    const generationSealedAt = record.generationSealedAt;
    if (observedAt === undefined || generationSealedAt === null) {
      return { kind: "indeterminate" };
    }
    return {
      kind: "stopped",
      evidence: {
        platform: "linux-cgroup-v2",
        reference,
        executionUnitId: record.executionUnitId,
        generationSealedAt,
        unitEmptyObservedAt: observedAt,
      },
    };
  }

  async #sealAndStop(record: LedgerRecord): Promise<string | undefined> {
    if (record.state !== "sealed") {
      record.state = "sealed";
      record.generationSealedAt = now();
      record.unitEmptyObservedAt = null;
    }
    await this.#writeRecord(record);
    try {
      await this.#stopService(record.serviceUnit);
      const observedAt = await this.#proveEmpty(record.executionUnitId);
      record.unitEmptyObservedAt = observedAt;
      await this.#writeRecord(record);
      await this.#systemctl(["stop", record.executionUnitId], true);
      return observedAt;
    } catch {
      return undefined;
    }
  }

  async #startUnit(
    record: LedgerRecord,
    profile: LinuxLaunchProfile,
    ingress: RuntimeIngressDescriptor | undefined,
    continuation: ProtectedRuntimeLaunchDirective | undefined,
    policy: RuntimeExecutionPolicy | undefined,
  ): Promise<void> {
    const nodeExecutable = this.#canonicalNodeExecutable;
    if (nodeExecutable === undefined) {
      throw new Error("Launcher configuration was not validated");
    }
    await this.#systemctl(["start", record.executionUnitId]);
    await this.#systemctl([
      "set-property",
      "--runtime",
      record.executionUnitId,
      `MemoryMax=${String(profile.memoryMaxBytes ?? 536_870_912)}`,
      `TasksMax=${String(profile.tasksMax ?? 64)}`,
      `CPUQuota=${String(profile.cpuQuotaPercent ?? 100)}%`,
    ]);
    const runtimeHome = this.#canonicalRuntimeHome;
    if (runtimeHome === undefined) {
      throw new Error("Runtime home was not validated");
    }
    const credentialSource = await this.#stageRuntimeCredential(
      record,
      ingress,
      continuation,
      policy,
    );
    try {
      await this.#execute("systemd-run", [
        "--quiet",
        `--unit=${record.serviceUnit}`,
        `--slice=${record.executionUnitId}`,
        "--service-type=exec",
        `--uid=${this.options.runtimeUser}`,
        `--gid=${this.options.runtimeGroup}`,
        `--working-directory=${profile.workspacePath}`,
        "--property=KillMode=control-group",
        "--property=TimeoutStopSec=2s",
        "--property=PrivateMounts=yes",
        // The supervisor consumes sanitized worker observation frames from the
        // exact worker unit journal; inheriting systemd-run's transient pipe
        // closes stdout after launch and can terminate a reporting worker.
        "--property=StandardOutput=journal",
        `--property=LoadCredential=${RUNTIME_CREDENTIAL_NAME}:${credentialSource}`,
        "--collect",
        "/usr/bin/env",
        "-i",
        `HOME=${runtimeHome}`,
        `CLAUDE_CONFIG_DIR=${join(runtimeHome, ".claude")}`,
        `LOGNAME=${this.options.runtimeUser}`,
        "PATH=/usr/local/bin:/usr/bin:/bin",
        `USER=${this.options.runtimeUser}`,
        `CREDENTIALS_DIRECTORY=/run/credentials/${record.serviceUnit}`,
        nodeExecutable,
        profile.workerEntrypoint,
        "--runtime-credential",
        RUNTIME_CREDENTIAL_NAME,
        ...profile.workerArguments,
      ]);
    } finally {
      await unlink(credentialSource).catch(() => undefined);
    }
  }

  async #stageRuntimeCredential(
    record: LedgerRecord,
    ingress: RuntimeIngressDescriptor | undefined,
    continuation: ProtectedRuntimeLaunchDirective | undefined,
    policy: RuntimeExecutionPolicy | undefined,
  ): Promise<string> {
    const directory = join(this.options.ledgerDirectory, "credentials");
    await prepareProtectedLauncherDirectory(directory, 0o700, 0);
    const path = join(
      directory,
      `${executionLedgerKey(record.reference.executionId)}-${randomUUID()}.json`,
    );
    const payload = JSON.stringify({
      version: 1,
      reference: record.reference,
      ingress: ingress ?? null,
      continuation:
        continuation === undefined
          ? null
          : continuation.kind === "resume"
            ? {
                kind: continuation.kind,
                sourceReference: continuation.sourceReference,
                sessionReference: continuation.sessionReference,
                protectedSessionToken: continuation.protectedSessionToken,
              }
            : {
                kind: continuation.kind,
                contextSummary: continuation.contextSummary,
              },
      policy: policy ?? null,
    });
    try {
      await writeFile(path, payload, { mode: 0o600, flag: "wx" });
      await chmod(path, 0o600);
      await chown(path, 0, 0);
      return path;
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
  }

  async #stopService(serviceUnit: string): Promise<void> {
    if (!(await this.#unitKnown(serviceUnit))) return;
    await this.#systemctl(
      ["kill", "--kill-whom=all", "--signal=SIGTERM", serviceUnit],
      true,
    );
    await this.#systemctl(["stop", serviceUnit], true);
  }

  async #proveEmpty(executionUnitId: string): Promise<string> {
    await this.#systemctl(["start", executionUnitId]);
    const controlGroup = (
      await this.#systemctl([
        "show",
        "--property=ControlGroup",
        "--value",
        executionUnitId,
      ])
    ).trim();
    if (!controlGroup.startsWith("/")) {
      throw new Error("Execution Unit has no cgroup v2 path");
    }
    const eventsPath = join("/sys/fs/cgroup", controlGroup, "cgroup.events");
    const deadline = Date.now() + this.#stopTimeoutMilliseconds;
    while (Date.now() <= deadline) {
      const events = await readFile(eventsPath, "utf8");
      if (/^populated 0$/mu.test(events)) return now();
      await sleep(25);
    }
    throw new Error("Execution Unit did not become empty");
  }

  async #unitActive(unit: string): Promise<boolean> {
    try {
      const state = (await this.#systemctl(["is-active", unit])).trim();
      return state === "active" || state === "activating";
    } catch {
      return false;
    }
  }

  async #unitKnown(unit: string): Promise<boolean> {
    try {
      return (
        (
          await this.#systemctl([
            "show",
            "--property=LoadState",
            "--value",
            unit,
          ])
        ).trim() !== "not-found"
      );
    } catch {
      return false;
    }
  }

  async #systemctl(
    args: readonly string[],
    tolerateFailure = false,
  ): Promise<string> {
    try {
      return await this.#execute("systemctl", args);
    } catch (error) {
      if (tolerateFailure) return "";
      throw error;
    }
  }

  async #execute(file: string, args: readonly string[]): Promise<string> {
    const result = await executeFile(file, args, {
      timeout: this.#commandTimeoutMilliseconds,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
    });
    return result.stdout;
  }

  #recordPath(executionId: string): string {
    return join(
      this.options.ledgerDirectory,
      `${executionLedgerKey(executionId)}.json`,
    );
  }

  async #readRecord(executionId: string): Promise<LedgerRecord | undefined> {
    try {
      return await this.#readRecordFile(
        this.#recordPath(executionId),
        executionId,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #readRecordFile(
    path: string,
    expectedExecutionId?: string,
  ): Promise<LedgerRecord> {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.uid !== 0 ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error("Supervisor ledger record is not protected");
    }
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    const record = parseLinuxLedgerRecord(value, expectedExecutionId);
    if (
      record === undefined ||
      path !== this.#recordPath(record.reference.executionId)
    ) {
      throw new Error("Invalid Supervisor ledger record");
    }
    return record;
  }

  async #writeRecord(record: LedgerRecord): Promise<void> {
    this.#assertRecord(record);
    const target = this.#recordPath(record.reference.executionId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    const directory = await open(this.options.ledgerDirectory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  #assertRecord(record: LedgerRecord): void {
    if (
      parseLinuxLedgerRecord(record, record.reference.executionId) === undefined
    ) {
      throw new Error(
        "Refusing to persist an invalid Supervisor ledger record",
      );
    }
  }

  async #withLock<T>(
    executionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#locks.get(executionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#locks.set(executionId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(executionId) === tail) {
        this.#locks.delete(executionId);
      }
    }
  }

  async #validateConfiguration(): Promise<void> {
    if (process.platform !== "linux" || process.getuid?.() !== 0) {
      throw new Error("Linux launcher requires Linux root authority");
    }
    const workspaceRoot = await realpath(this.options.workspaceRoot);
    const nodePath = await realpath(this.options.nodeExecutable);
    const runtimeHome = await realpath(this.options.runtimeHome);
    const [runtimeUserId, runtimeGroupId, socketGroupId] = await Promise.all([
      this.#userId(this.options.runtimeUser),
      this.#groupId(this.options.runtimeGroup),
      this.#groupId(this.options.socketGroup),
    ]);
    const supplementaryGroups = (
      await this.#execute("id", ["-G", this.options.runtimeUser])
    )
      .trim()
      .split(/\s+/u)
      .map(Number);
    if (
      !isPrivilegeSeparatedRuntimeIdentity(
        runtimeUserId,
        runtimeGroupId,
        socketGroupId,
        supplementaryGroups,
      )
    ) {
      throw new Error("Runtime identity is not privilege-separated");
    }
    const [nodeStat, runtimeHomeStat] = await Promise.all([
      stat(nodePath),
      stat(runtimeHome),
    ]);
    if (
      !nodeStat.isFile() ||
      nodeStat.uid !== 0 ||
      (nodeStat.mode & 0o022) !== 0
    ) {
      throw new Error("Configured Node executable is not protected");
    }
    if (
      !runtimeHomeStat.isDirectory() ||
      runtimeHomeStat.uid !== runtimeUserId ||
      runtimeHomeStat.gid !== runtimeGroupId ||
      (runtimeHomeStat.mode & 0o077) !== 0
    ) {
      throw new Error("Configured Runtime home is not isolated");
    }
    this.#canonicalWorkspaceRoot = workspaceRoot;
    this.#canonicalNodeExecutable = nodePath;
    this.#canonicalRuntimeHome = runtimeHome;
    this.#runtimeUserId = runtimeUserId;
    this.#runtimeGroupId = runtimeGroupId;
    this.#canonicalProfiles.clear();
    for (const [profileId, profile] of Object.entries(this.options.profiles)) {
      if (
        profile.workspaceIdentity.length === 0 ||
        profile.workspaceIdentity.length > 128
      ) {
        throw new Error("Launch profile has an invalid Workspace identity");
      }
      const workspace = await realpath(profile.workspacePath);
      const entrypoint = await realpath(profile.workerEntrypoint);
      const [entrypointStat, workspaceStat] = await Promise.all([
        stat(entrypoint),
        stat(workspace),
      ]);
      if (
        !isWithin(workspaceRoot, workspace) ||
        !entrypointStat.isFile() ||
        entrypointStat.uid !== 0 ||
        (entrypointStat.mode & 0o022) !== 0
      ) {
        throw new Error("Launch profile leaves the protected boundary");
      }
      this.#canonicalProfiles.set(profileId, {
        workspacePath: workspace,
        workspaceIdentity:
          profile.workspaceIdentity === "filesystem"
            ? `${String(workspaceStat.dev)}:${String(workspaceStat.ino)}`
            : profile.workspaceIdentity,
        workerEntrypoint: entrypoint,
      });
    }
  }

  async #validatedProfile(
    reference: ExecutionReference,
  ): Promise<LinuxLaunchProfile> {
    const profile = this.options.profiles[reference.launchProfileId];
    const canonical = this.#canonicalProfiles.get(reference.launchProfileId);
    if (
      profile === undefined ||
      canonical === undefined ||
      canonical.workspaceIdentity !== reference.workspaceIdentity ||
      this.#canonicalWorkspaceRoot === undefined ||
      this.#canonicalNodeExecutable === undefined
    ) {
      throw new Error("Execution Reference does not match a launch profile");
    }
    const [
      workspaceRoot,
      workspacePath,
      workerEntrypoint,
      nodeExecutable,
      runtimeHome,
    ] = await Promise.all([
      realpath(this.options.workspaceRoot),
      realpath(profile.workspacePath),
      realpath(profile.workerEntrypoint),
      realpath(this.options.nodeExecutable),
      realpath(this.options.runtimeHome),
    ]);
    const [entrypointStat, nodeStat, runtimeHomeStat] = await Promise.all([
      stat(workerEntrypoint),
      stat(nodeExecutable),
      stat(runtimeHome),
    ]);
    if (
      workspaceRoot !== this.#canonicalWorkspaceRoot ||
      workspacePath !== canonical.workspacePath ||
      workerEntrypoint !== canonical.workerEntrypoint ||
      nodeExecutable !== this.#canonicalNodeExecutable ||
      runtimeHome !== this.#canonicalRuntimeHome ||
      this.#runtimeUserId === undefined ||
      this.#runtimeGroupId === undefined ||
      !isWithin(workspaceRoot, workspacePath) ||
      !entrypointStat.isFile() ||
      entrypointStat.uid !== 0 ||
      (entrypointStat.mode & 0o022) !== 0 ||
      !nodeStat.isFile() ||
      nodeStat.uid !== 0 ||
      (nodeStat.mode & 0o022) !== 0 ||
      !runtimeHomeStat.isDirectory() ||
      runtimeHomeStat.uid !== this.#runtimeUserId ||
      runtimeHomeStat.gid !== this.#runtimeGroupId ||
      (runtimeHomeStat.mode & 0o077) !== 0
    ) {
      throw new Error("Launch profile changed after launcher validation");
    }
    return {
      ...profile,
      workspacePath,
      workerEntrypoint,
    };
  }

  async #sealPriorLauncherEpoch(): Promise<Set<string>> {
    const recordedUnits = new Set<string>();
    const entries = await readdir(this.options.ledgerDirectory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.name.endsWith(".json")) continue;
      if (!entry.isFile()) {
        throw new Error("Supervisor ledger contains a non-file record");
      }
      const discovered = await this.#readRecordFile(
        join(this.options.ledgerDirectory, entry.name),
      );
      recordedUnits.add(discovered.executionUnitId);
      recordedUnits.add(discovered.serviceUnit);
      await this.#withLock(discovered.reference.executionId, async () => {
        const record = await this.#readRecord(discovered.reference.executionId);
        if (
          record === undefined ||
          (await this.#sealAndStop(record)) === undefined
        ) {
          throw new Error("Could not fence a prior launcher epoch");
        }
      });
    }
    return recordedUnits;
  }

  async #sealUnitOnlyOrphans(
    recordedUnits: ReadonlySet<string>,
  ): Promise<void> {
    const listed = await this.#systemctl([
      "list-units",
      "--all",
      "--full",
      "--no-legend",
      "--plain",
      "agentport-worker-*.service",
      "agentport-execution-*.slice",
    ]);
    const orphanServices = new Set<string>();
    const orphanSlices = new Set<string>();
    for (const line of listed.split("\n")) {
      const unit = line.trim().split(/\s+/u)[0];
      if (unit === undefined || recordedUnits.has(unit)) continue;
      const service = /^agentport-worker-([a-f0-9]{24})\.service$/u.exec(unit);
      if (service !== null) {
        const suffix = service[1];
        if (suffix === undefined) continue;
        orphanServices.add(unit);
        orphanSlices.add(`agentport-execution-${suffix}.slice`);
      } else if (/^agentport-execution-[a-f0-9]{24}\.slice$/u.test(unit)) {
        orphanSlices.add(unit);
      }
    }
    for (const service of orphanServices) await this.#stopService(service);
    for (const slice of orphanSlices) {
      await this.#proveEmpty(slice);
      await this.#systemctl(["stop", slice], true);
    }
  }

  async #prepareIngressDirectory(socketGroupId: number): Promise<void> {
    const ingressGroupId = await this.#groupId(this.options.ingressGroup);
    if (
      ingressGroupId === socketGroupId ||
      ingressGroupId === this.#runtimeGroupId
    ) {
      throw new Error(
        "Ingress group must differ from the socket and Runtime groups",
      );
    }
    const ingressDirectory = this.options.ingressDirectory;
    await ensureLauncherIngressDirectory(
      ingressGroupId,
      () =>
        observeIngressDirectory(
          ingressDirectory,
          process.getuid?.() ?? -1,
          lstatIngressPath,
        ),
      () =>
        prepareProtectedLauncherDirectory(
          ingressDirectory,
          INGRESS_DIRECTORY_MODE,
          ingressGroupId,
        ),
    );
  }

  async #groupId(name: string): Promise<number> {
    const groups = await readFile("/etc/group", "utf8");
    for (const line of groups.split("\n")) {
      const [groupName, , groupId] = line.split(":");
      if (groupName !== name) continue;
      const value = Number(groupId);
      if (Number.isSafeInteger(value) && value >= 0) return value;
    }
    throw new Error("Configured launcher socket group does not exist");
  }

  async #userId(name: string): Promise<number> {
    const users = await readFile("/etc/passwd", "utf8");
    for (const line of users.split("\n")) {
      const [userName, , userId] = line.split(":");
      if (userName !== name) continue;
      const value = Number(userId);
      if (Number.isSafeInteger(value) && value >= 0) return value;
    }
    throw new Error("Configured Runtime user does not exist");
  }

  async #removeStaleSocket(): Promise<void> {
    try {
      const metadata = await lstat(this.options.socketPath);
      if (!metadata.isSocket()) {
        throw new Error("Launcher socket path is occupied by a non-socket");
      }
      await unlink(this.options.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
