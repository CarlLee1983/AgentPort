import { createHash } from "node:crypto";

import {
  MAX_CONTEXT_SUMMARY_BYTES,
  type ExecutionReference,
} from "../../core/types.js";
import type {
  ProtectedRuntimeLaunchDirective,
  RuntimeExecutionPolicy,
  RuntimeIngressDescriptor,
} from "../../core/execution-supervisor.js";
import { sessionReferenceFor } from "../../runtime/claude/session-reference.js";

export const MAX_LAUNCHER_FRAME_BYTES = 32 * 1024;

export function executionLedgerKey(executionId: string): string {
  return createHash("sha256").update(executionId).digest("hex");
}

export function executionUnitNames(executionId: string): {
  executionUnitId: string;
  serviceUnit: string;
} {
  const suffix = executionLedgerKey(executionId).slice(0, 24);
  return {
    executionUnitId: `agentport-execution-${suffix}.slice`,
    serviceUnit: `agentport-worker-${suffix}.service`,
  };
}

export type LinuxLauncherExecutionAction =
  "start" | "revoke_and_stop" | "reconcile";

export type LinuxLauncherRequest =
  | {
      requestId: string;
      action: "dispatch_authority";
    }
  | {
      requestId: string;
      action: LinuxLauncherExecutionAction;
      reference: ExecutionReference;
      ingress?: RuntimeIngressDescriptor;
      continuation?: ProtectedRuntimeLaunchDirective;
      policy?: RuntimeExecutionPolicy;
    };

export type LinuxLauncherResult =
  | { kind: "started"; executionUnitId: string }
  | {
      kind: "stopped";
      evidence: {
        platform: "linux-cgroup-v2";
        reference: ExecutionReference;
        executionUnitId: string;
        generationSealedAt: string;
        unitEmptyObservedAt: string;
      };
    }
  | { kind: "running"; executionUnitId: string }
  | { kind: "pending" }
  | { kind: "conflict" }
  | { kind: "unavailable" }
  | { kind: "indeterminate" }
  | { kind: "dispatch_authority"; daemonEpoch: string };

export type LinuxLauncherResponse = {
  requestId: string;
  result: LinuxLauncherResult;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function isProtectedContinuation(
  value: unknown,
  reference: ExecutionReference,
): value is ProtectedRuntimeLaunchDirective {
  if (!isRecord(value)) return false;
  if (value.kind === "fresh_session") {
    return (
      Object.keys(value).length === 2 &&
      typeof value.contextSummary === "string" &&
      Buffer.byteLength(value.contextSummary, "utf8") <=
        MAX_CONTEXT_SUMMARY_BYTES
    );
  }
  return (
    Object.keys(value).length === 4 &&
    value.kind === "resume" &&
    isExecutionReference(value.sourceReference) &&
    value.sourceReference.workspaceIdentity === reference.workspaceIdentity &&
    typeof value.sessionReference === "string" &&
    typeof value.protectedSessionToken === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value.protectedSessionToken) &&
    value.sessionReference ===
      sessionReferenceFor(value.sourceReference, value.protectedSessionToken)
  );
}

export function isExecutionReference(
  value: unknown,
): value is ExecutionReference {
  return (
    isRecord(value) &&
    isIdentifier(value.executionId) &&
    isIdentifier(value.generation) &&
    isIdentifier(value.daemonEpoch) &&
    isIdentifier(value.launchProfileId) &&
    isIdentifier(value.workspaceIdentity)
  );
}

export function parseLauncherRequest(
  encoded: string,
): LinuxLauncherRequest | undefined {
  if (Buffer.byteLength(encoded, "utf8") > MAX_LAUNCHER_FRAME_BYTES) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !isIdentifier(value.requestId)) {
    return undefined;
  }
  if (value.action === "dispatch_authority") {
    return Object.keys(value).length === 2
      ? { requestId: value.requestId, action: "dispatch_authority" }
      : undefined;
  }
  const ingress = value.ingress;
  const continuation = value.continuation;
  const policy = value.policy;
  const validIngress =
    ingress === undefined ||
    (isRecord(ingress) &&
      Object.keys(ingress).length === 2 &&
      typeof ingress.endpoint === "string" &&
      ingress.endpoint.startsWith("/") &&
      ingress.endpoint.length <= 96 &&
      typeof ingress.token === "string" &&
      /^[A-Za-z0-9_-]{43}$/u.test(ingress.token));
  const validPolicy =
    policy === undefined ||
    (isRecord(policy) &&
      Object.keys(policy).length === 2 &&
      Number.isSafeInteger(policy.executionLimitSeconds) &&
      Number(policy.executionLimitSeconds) > 0 &&
      Number.isSafeInteger(policy.inputWaitSeconds) &&
      Number(policy.inputWaitSeconds) > 0);
  if (
    !["start", "revoke_and_stop", "reconcile"].includes(String(value.action)) ||
    !isExecutionReference(value.reference) ||
    !validIngress ||
    !validPolicy ||
    !(
      continuation === undefined ||
      isProtectedContinuation(continuation, value.reference)
    ) ||
    Object.keys(value).length !==
      3 +
        Number(ingress !== undefined) +
        Number(continuation !== undefined) +
        Number(policy !== undefined) ||
    (value.action !== "start" &&
      (ingress !== undefined ||
        continuation !== undefined ||
        policy !== undefined))
  ) {
    return undefined;
  }
  return {
    requestId: value.requestId,
    action: value.action as LinuxLauncherExecutionAction,
    reference: value.reference,
    ...(ingress === undefined
      ? {}
      : { ingress: ingress as unknown as RuntimeIngressDescriptor }),
    ...(continuation === undefined ? {} : { continuation }),
    ...(policy === undefined
      ? {}
      : { policy: policy as unknown as RuntimeExecutionPolicy }),
  };
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

function parseLauncherResult(value: unknown): LinuxLauncherResult | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (
    value.kind === "dispatch_authority" &&
    isIdentifier(value.daemonEpoch) &&
    Object.keys(value).length === 2
  ) {
    return { kind: "dispatch_authority", daemonEpoch: value.daemonEpoch };
  }
  if (
    ["pending", "conflict", "unavailable", "indeterminate"].includes(value.kind)
  ) {
    return { kind: value.kind } as LinuxLauncherResult;
  }
  if (
    (value.kind === "started" || value.kind === "running") &&
    isIdentifier(value.executionUnitId)
  ) {
    return {
      kind: value.kind,
      executionUnitId: value.executionUnitId,
    };
  }
  if (value.kind !== "stopped" || !isRecord(value.evidence)) {
    return undefined;
  }
  const evidence = value.evidence;
  if (
    evidence.platform !== "linux-cgroup-v2" ||
    !isExecutionReference(evidence.reference) ||
    !isIdentifier(evidence.executionUnitId) ||
    !isTimestamp(evidence.generationSealedAt) ||
    !isTimestamp(evidence.unitEmptyObservedAt)
  ) {
    return undefined;
  }
  return {
    kind: "stopped",
    evidence: {
      platform: "linux-cgroup-v2",
      reference: evidence.reference,
      executionUnitId: evidence.executionUnitId,
      generationSealedAt: evidence.generationSealedAt,
      unitEmptyObservedAt: evidence.unitEmptyObservedAt,
    },
  };
}

export function parseLauncherResponse(
  encoded: string,
  requestId: string,
): LinuxLauncherResponse | undefined {
  if (Buffer.byteLength(encoded, "utf8") > MAX_LAUNCHER_FRAME_BYTES) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.requestId !== requestId) return undefined;
  const result = parseLauncherResult(value.result);
  return result === undefined ? undefined : { requestId, result };
}

export function encodeLauncherFrame(value: unknown): string {
  const encoded = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > MAX_LAUNCHER_FRAME_BYTES) {
    throw new Error("Launcher frame exceeds the protocol bound");
  }
  return encoded;
}
