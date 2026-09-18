/**
 * Host-level operational readiness. This deliberately has no Task or
 * Execution dependency: it is safe to project through an administrator-only
 * observation boundary.
 */
export type DeploymentReadinessLevel =
  "installed" | "service-ready" | "execution-ready" | "recovery-blocked";

export type DeploymentReadinessReasonCode =
  | "observation-unavailable"
  | "observation-stale"
  | "observation-time-invalid"
  | "service-unavailable"
  | "recovery-required"
  | "storage-incident"
  | "recovery-uncertain"
  | "storage-uncertain"
  | "topology-invalid"
  | "topology-uncertain"
  | "no-agents-configured"
  | "agents-uncertain"
  | "launcher-unavailable"
  | "launcher-uncertain"
  | "runtime-unverified"
  | "runtime-uncertain"
  | "caller-provisioning-absent"
  | "caller-provisioning-uncertain"
  | "ready";

type ObservationState = "available" | "unavailable" | "unknown";

/** A bounded summary; it intentionally contains no paths, identities, or errors. */
export interface DeploymentCapabilitySummary {
  readonly service: ObservationState;
  readonly agents: "configured" | "none" | "unknown";
  readonly launcher: "ready" | "unavailable" | "unknown";
  readonly runtime: "verified" | "unverified" | "unknown";
  readonly callerProvisioning: "present" | "absent" | "unknown";
  readonly protectedTopology: "valid" | "invalid" | "unknown";
}

export interface DeploymentReadinessObservation {
  /** ISO-8601 UTC timestamp for this observation, or null when it was not observed. */
  readonly observedAt: string | null;
  /** A caller must explicitly mark a cached observation stale. */
  readonly observation: "current" | "stale" | "unobserved";
  readonly capabilities: DeploymentCapabilitySummary;
  readonly recovery: "clear" | "blocked" | "unknown";
  readonly storage: "healthy" | "incident" | "unknown";
}

export interface DeploymentReadinessSnapshot {
  readonly level: DeploymentReadinessLevel;
  readonly reason: DeploymentReadinessReasonCode;
  readonly observedAt: string | null;
  readonly capabilities: DeploymentCapabilitySummary;
}

const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function hasValidObservedAt(observedAt: string | null): boolean {
  if (observedAt === null || !ISO_UTC_TIMESTAMP.test(observedAt)) {
    return false;
  }

  const parsed = new Date(observedAt);
  if (!Number.isFinite(parsed.getTime())) {
    return false;
  }

  return parsed.toISOString().replace(".000Z", "Z") === observedAt;
}

function sanitizedCapabilities(
  capabilities: DeploymentCapabilitySummary,
): DeploymentCapabilitySummary {
  return Object.freeze({
    service: capabilities.service,
    agents: capabilities.agents,
    launcher: capabilities.launcher,
    runtime: capabilities.runtime,
    callerProvisioning: capabilities.callerProvisioning,
    protectedTopology: capabilities.protectedTopology,
  });
}

function snapshot(
  level: DeploymentReadinessLevel,
  reason: DeploymentReadinessReasonCode,
  observation: DeploymentReadinessObservation,
): DeploymentReadinessSnapshot {
  return Object.freeze({
    level,
    reason,
    observedAt: observation.observedAt,
    capabilities: sanitizedCapabilities(observation.capabilities),
  });
}

/**
 * Produces a fail-closed, immutable readiness projection from already
 * sanitized host observations. It performs no I/O and does not infer facts
 * absent from the observation.
 */
export function evaluateDeploymentReadiness(
  observation: DeploymentReadinessObservation,
): DeploymentReadinessSnapshot {
  if (observation.observation === "unobserved") {
    return snapshot("installed", "observation-unavailable", observation);
  }
  if (!hasValidObservedAt(observation.observedAt)) {
    return snapshot("installed", "observation-time-invalid", observation);
  }
  if (observation.observation === "stale") {
    return snapshot("installed", "observation-stale", observation);
  }
  if (observation.capabilities.service !== "available") {
    return snapshot("installed", "service-unavailable", observation);
  }
  if (observation.recovery === "blocked") {
    return snapshot("recovery-blocked", "recovery-required", observation);
  }
  if (observation.storage === "incident") {
    return snapshot("recovery-blocked", "storage-incident", observation);
  }
  if (observation.recovery === "unknown") {
    return snapshot("service-ready", "recovery-uncertain", observation);
  }
  if (observation.storage === "unknown") {
    return snapshot("service-ready", "storage-uncertain", observation);
  }
  if (observation.capabilities.protectedTopology === "invalid") {
    return snapshot("service-ready", "topology-invalid", observation);
  }
  if (observation.capabilities.protectedTopology === "unknown") {
    return snapshot("service-ready", "topology-uncertain", observation);
  }
  if (observation.capabilities.agents === "none") {
    return snapshot("service-ready", "no-agents-configured", observation);
  }
  if (observation.capabilities.agents === "unknown") {
    return snapshot("service-ready", "agents-uncertain", observation);
  }
  if (observation.capabilities.launcher === "unavailable") {
    return snapshot("service-ready", "launcher-unavailable", observation);
  }
  if (observation.capabilities.launcher === "unknown") {
    return snapshot("service-ready", "launcher-uncertain", observation);
  }
  if (observation.capabilities.runtime === "unverified") {
    return snapshot("service-ready", "runtime-unverified", observation);
  }
  if (observation.capabilities.runtime === "unknown") {
    return snapshot("service-ready", "runtime-uncertain", observation);
  }
  if (observation.capabilities.callerProvisioning === "absent") {
    return snapshot("service-ready", "caller-provisioning-absent", observation);
  }
  if (observation.capabilities.callerProvisioning === "unknown") {
    return snapshot(
      "service-ready",
      "caller-provisioning-uncertain",
      observation,
    );
  }

  return snapshot("execution-ready", "ready", observation);
}
