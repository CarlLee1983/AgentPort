import { describe, expect, it } from "vitest";

import {
  evaluateDeploymentReadiness,
  type DeploymentReadinessObservation,
} from "../../src/daemon/deployment-readiness.js";

const completeObservation: DeploymentReadinessObservation = {
  observedAt: "2026-09-18T12:34:56.789Z",
  observation: "current",
  capabilities: {
    service: "available",
    agents: "configured",
    launcher: "ready",
    runtime: "verified",
    callerProvisioning: "present",
    protectedTopology: "valid",
  },
  recovery: "clear",
  storage: "healthy",
};

describe("Deployment Readiness", () => {
  it("is execution-ready only when every host prerequisite is observed", () => {
    expect(evaluateDeploymentReadiness(completeObservation)).toEqual({
      level: "execution-ready",
      reason: "ready",
      observedAt: "2026-09-18T12:34:56.789Z",
      capabilities: completeObservation.capabilities,
    });
  });

  it("distinguishes installed service absence from a queryable service", () => {
    const readiness = evaluateDeploymentReadiness({
      ...completeObservation,
      capabilities: {
        ...completeObservation.capabilities,
        service: "unavailable",
      },
    });

    expect(readiness).toMatchObject({
      level: "installed",
      reason: "service-unavailable",
    });
  });

  it("keeps a queryable daemon with zero Agents service-ready", () => {
    expect(
      evaluateDeploymentReadiness({
        ...completeObservation,
        capabilities: { ...completeObservation.capabilities, agents: "none" },
      }),
    ).toMatchObject({ level: "service-ready", reason: "no-agents-configured" });
  });

  it.each([
    ["recovery", { recovery: "blocked" as const }, "recovery-required"],
    ["storage incident", { storage: "incident" as const }, "storage-incident"],
  ])("reports %s as recovery-blocked", (_label, changes, reason) => {
    expect(
      evaluateDeploymentReadiness({ ...completeObservation, ...changes }),
    ).toMatchObject({ level: "recovery-blocked", reason });
  });

  it.each([
    ["unobserved", { observation: "unobserved" as const, observedAt: null }],
    ["stale", { observation: "stale" as const }],
    ["invalid timestamp", { observedAt: "not-a-timestamp" }],
    ["unknown recovery", { recovery: "unknown" as const }],
    ["unknown storage", { storage: "unknown" as const }],
  ])("never permits execution for %s observations", (_label, changes) => {
    expect(
      evaluateDeploymentReadiness({ ...completeObservation, ...changes }),
    ).not.toMatchObject({ level: "execution-ready" });
  });

  it.each([
    ["protected topology", { protectedTopology: "invalid" as const }],
    ["launcher", { launcher: "unavailable" as const }],
    ["runtime", { runtime: "unverified" as const }],
    ["caller provisioning", { callerProvisioning: "absent" as const }],
  ])("does not infer execution readiness without %s", (_label, changes) => {
    expect(
      evaluateDeploymentReadiness({
        ...completeObservation,
        capabilities: { ...completeObservation.capabilities, ...changes },
      }),
    ).toMatchObject({ level: "service-ready" });
  });

  it("returns an immutable sanitized copy of the capability summary", () => {
    const observation = {
      ...completeObservation,
      capabilities: {
        ...completeObservation.capabilities,
        secret: "must-not-be-projected",
      },
    } as DeploymentReadinessObservation;
    const readiness = evaluateDeploymentReadiness(observation);

    expect(Object.isFrozen(readiness)).toBe(true);
    expect(Object.isFrozen(readiness.capabilities)).toBe(true);
    expect(readiness.capabilities).not.toBe(observation.capabilities);
    expect(Object.keys(readiness.capabilities).sort()).toEqual([
      "agents",
      "callerProvisioning",
      "launcher",
      "protectedTopology",
      "runtime",
      "service",
    ]);
  });
});
