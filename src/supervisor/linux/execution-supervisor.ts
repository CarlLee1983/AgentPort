import type {
  ExecutionSupervisor,
  ProtectedRuntimeLaunchDirective,
  RuntimeExecutionPolicy,
  RuntimeIngressDescriptor,
  SupervisorReconcileResult,
  SupervisorStartResult,
  SupervisorStopResult,
  VerifiedStopEvidence,
} from "../../core/execution-supervisor.js";
import type { ExecutionReference } from "../../core/types.js";
import { LinuxLauncherClient } from "./launcher-client.js";
import {
  executionUnitNames,
  type LinuxLauncherResult,
} from "./launcher-protocol.js";

const authenticEvidence = new WeakSet<object>();

function evidenceFrom(
  result: Extract<LinuxLauncherResult, { kind: "stopped" }>,
  expectedReference: ExecutionReference,
): VerifiedStopEvidence | undefined {
  const evidenceValue = result.evidence;
  if (
    !sameReference(evidenceValue.reference, expectedReference) ||
    evidenceValue.executionUnitId !==
      executionUnitNames(expectedReference.executionId).executionUnitId ||
    Date.parse(evidenceValue.generationSealedAt) >
      Date.parse(evidenceValue.unitEmptyObservedAt)
  ) {
    return undefined;
  }
  const evidence: VerifiedStopEvidence = Object.freeze({
    kind: "verified",
    ...evidenceValue,
  });
  authenticEvidence.add(evidence);
  return evidence;
}

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

export function isVerifiedLinuxStopEvidence(
  value: unknown,
): value is VerifiedStopEvidence {
  return (
    typeof value === "object" && value !== null && authenticEvidence.has(value)
  );
}

export class LinuxExecutionSupervisor implements ExecutionSupervisor {
  constructor(private readonly launcher: LinuxLauncherClient) {}

  async start(
    reference: ExecutionReference,
    ingress?: RuntimeIngressDescriptor,
    continuation?: ProtectedRuntimeLaunchDirective,
    policy?: RuntimeExecutionPolicy,
  ): Promise<SupervisorStartResult> {
    const result = await this.launcher.request(
      "start",
      reference,
      ingress,
      continuation,
      policy,
    );
    if (result.kind === "started") return result;
    if (
      result.kind === "pending" ||
      result.kind === "conflict" ||
      result.kind === "unavailable" ||
      result.kind === "indeterminate"
    ) {
      return result;
    }
    return { kind: "indeterminate" };
  }

  async revokeAndStop(
    reference: ExecutionReference,
  ): Promise<SupervisorStopResult> {
    const result = await this.launcher.request("revoke_and_stop", reference);
    if (result.kind === "stopped") {
      const evidence = evidenceFrom(result, reference);
      return evidence === undefined
        ? { kind: "indeterminate" }
        : { kind: "stopped", evidence };
    }
    if (
      result.kind === "pending" ||
      result.kind === "conflict" ||
      result.kind === "unavailable" ||
      result.kind === "indeterminate"
    ) {
      return result;
    }
    return { kind: "indeterminate" };
  }

  async reconcile(
    reference: ExecutionReference,
  ): Promise<SupervisorReconcileResult> {
    const result = await this.launcher.request("reconcile", reference);
    if (result.kind === "stopped") {
      const evidence = evidenceFrom(result, reference);
      return evidence === undefined
        ? { kind: "indeterminate" }
        : { kind: "stopped", evidence };
    }
    if (
      result.kind === "running" ||
      result.kind === "pending" ||
      result.kind === "conflict" ||
      result.kind === "unavailable" ||
      result.kind === "indeterminate"
    ) {
      return result;
    }
    return { kind: "indeterminate" };
  }
}
