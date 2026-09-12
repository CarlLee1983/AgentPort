import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

const ACTOR = { principalId: "principal-a" };

describe("Registry revision fence", () => {
  it("rechecks authorization after SQL writes and before COMMIT", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      await fixture.store.probe("armCommitBarrier");
      const pending = fixture.service.submitTask(ACTOR, {
        operationId: "commit-window-race",
        agentId: "agent-a",
        instruction: "must roll back after the post-write authorization check",
      });
      await fixture.store.probe("waitForCommitBarrier");

      const replacement = fixture.registry.replace({
        ...fixture.registryConfiguration,
        principals: fixture.registryConfiguration.principals.map((principal) =>
          principal.principalId === ACTOR.principalId
            ? { ...principal, active: false }
            : principal,
        ),
      });
      await fixture.store.probe("waitForRegistryRevision", 2);
      await fixture.store.probe("releaseCommitBarrier");

      await expect(pending).rejects.toMatchObject({
        code: "storage_unavailable",
        retryable: true,
      });
      await replacement;
      await expect(
        fixture.store.listTasks({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          limit: 10,
        }),
      ).resolves.toMatchObject({ tasks: [] });
    } finally {
      await fixture.store.probe("releaseCommitBarrier").catch(() => undefined);
      await fixture.close();
    }
  });

  it("rolls back a submit when membership is revoked before commit", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const blocking = fixture.store.probe("block", 300).catch(() => undefined);
      const pending = fixture.service.submitTask(ACTOR, {
        operationId: "membership-race",
        agentId: "agent-a",
        instruction: "must not commit under revoked membership",
      });
      const replacement = fixture.registry.replace({
        ...fixture.registryConfiguration,
        principals: fixture.registryConfiguration.principals.map((principal) =>
          principal.principalId === ACTOR.principalId
            ? { ...principal, active: false }
            : principal,
        ),
      });

      await expect(pending).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      await Promise.all([blocking, replacement]);
      expect(
        await fixture.store.listTasks({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          limit: 10,
        }),
      ).toMatchObject({ tasks: [] });
    } finally {
      await fixture.close();
    }
  });

  it("re-evaluates replaced policy before admitting a queued submit", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const blocking = fixture.store.probe("block", 300).catch(() => undefined);
      const pending = fixture.service.submitTask(ACTOR, {
        operationId: "policy-race",
        agentId: "agent-a",
        instruction: "must use the replacement policy",
        executionLimitSeconds: 600,
      });
      const replacement = fixture.registry.replace({
        ...fixture.registryConfiguration,
        agents: fixture.registryConfiguration.agents.map((agent) =>
          agent.agentId === "agent-a"
            ? {
                ...agent,
                configurationRevision: "fixture-config-2",
                policy: {
                  ...agent.policy,
                  maximumExecutionLimitSeconds: 60,
                },
              }
            : agent,
        ),
      });

      await expect(pending).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      await Promise.all([blocking, replacement]);
      expect(
        await fixture.store.listTasks({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          limit: 10,
        }),
      ).toMatchObject({ tasks: [] });
      await expect(
        fixture.service.submitTask(ACTOR, {
          operationId: "policy-race",
          agentId: "agent-a",
          instruction: "must use the replacement policy",
          executionLimitSeconds: 600,
        }),
      ).rejects.toMatchObject({ code: "validation_error" });
    } finally {
      await fixture.close();
    }
  });

  it("rolls back cancel when the Agent allowlist is removed before commit", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const submitted = await fixture.service.submitTask(ACTOR, {
        operationId: "cancel-race-submit",
        agentId: "agent-a",
        instruction: "remain queued after authorization changes",
      });
      const blocking = fixture.store.probe("block", 300).catch(() => undefined);
      const pending = fixture.service.cancelTask(ACTOR, {
        operationId: "allowlist-race",
        taskId: submitted.task.taskId,
      });
      const replacement = fixture.registry.replace({
        ...fixture.registryConfiguration,
        principals: fixture.registryConfiguration.principals.map((principal) =>
          principal.principalId === ACTOR.principalId
            ? { ...principal, allowedAgentIds: ["agent-revokable"] }
            : principal,
        ),
      });

      await expect(pending).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      await Promise.all([blocking, replacement]);
      expect(
        await fixture.store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).toMatchObject({ state: "queued", revision: 1 });
    } finally {
      await fixture.close();
    }
  });

  it("rejects the in-flight call and uses a replaced binding only after explicit retry", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const replacementWorkspace = join(
        fixture.directory,
        "workspace-a-replacement",
      );
      await mkdir(replacementWorkspace);
      const canonicalReplacementWorkspace =
        await realpath(replacementWorkspace);
      const blocking = fixture.store.probe("block", 300).catch(() => undefined);
      const request = {
        operationId: "binding-race",
        agentId: "agent-a",
        instruction: "retry explicitly under the replacement binding",
      };
      const pending = fixture.service.submitTask(ACTOR, request);
      const replacement = fixture.registry.replace({
        ...fixture.registryConfiguration,
        agents: fixture.registryConfiguration.agents.map((agent) =>
          agent.agentId === "agent-a"
            ? {
                ...agent,
                workspacePath: replacementWorkspace,
                configurationRevision: "fixture-config-2",
                runtimeDriver: "replacement-unreachable-driver",
                runtimeVersion: "2.0.0",
              }
            : agent,
        ),
      });

      await expect(pending).rejects.toMatchObject({
        code: "storage_unavailable",
        retryable: true,
      });
      await Promise.all([blocking, replacement]);
      await expect(
        fixture.service.submitTask(ACTOR, request),
      ).resolves.toMatchObject({ replayed: false, task: { state: "queued" } });
      const durability = (await fixture.store.probe("inspectDurability")) as {
        bindingPayloads: Array<{
          configurationRevision: string;
          runtimeDriver: string;
          runtimeVersion: string;
          workspaceIdentity: { canonicalPath: string };
        }>;
      };
      expect(durability.bindingPayloads).toMatchObject([
        {
          configurationRevision: "fixture-config-2",
          runtimeDriver: "replacement-unreachable-driver",
          runtimeVersion: "2.0.0",
          workspaceIdentity: { canonicalPath: canonicalReplacementWorkspace },
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("does not move an in-flight submit into a replacement Access Scope", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const blocking = fixture.store.probe("block", 300).catch(() => undefined);
      const pending = fixture.service.submitTask(ACTOR, {
        operationId: "scope-race",
        agentId: "agent-a",
        instruction: "must not cross the authorization linearization point",
      });
      const replacement = fixture.registry.replace({
        ...fixture.registryConfiguration,
        principals: fixture.registryConfiguration.principals.map((principal) =>
          principal.principalId === ACTOR.principalId
            ? { ...principal, accessScopeId: "scope-replaced" }
            : principal,
        ),
      });

      await expect(pending).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      await Promise.all([blocking, replacement]);
      await expect(
        fixture.store.listTasks({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          limit: 10,
        }),
      ).resolves.toMatchObject({ tasks: [] });
      await expect(
        fixture.store.listTasks({
          accessScopeId: "scope-replaced",
          allowedAgentIds: ["agent-a"],
          limit: 10,
        }),
      ).resolves.toMatchObject({ tasks: [] });
    } finally {
      await fixture.close();
    }
  });

  it("fails subsequent mutations closed when a replacement fence cannot install", async () => {
    const fixture = await createDurableAdmissionFixture();
    const submitted = await fixture.service.submitTask(ACTOR, {
      operationId: "fence-failure-submit",
      agentId: "agent-a",
      instruction: "remain readable after the mutation fence fails",
    });
    await fixture.store.close();

    await expect(
      fixture.registry.replace(fixture.registryConfiguration),
    ).rejects.toMatchObject({ code: "storage_unavailable" });
    await expect(
      fixture.service.submitTask(ACTOR, {
        operationId: "after-fence-failure",
        agentId: "agent-a",
        instruction: "must fail closed",
      }),
    ).rejects.toMatchObject({ code: "storage_unavailable" });
    await expect(
      fixture.service.cancelTask(ACTOR, {
        operationId: "cancel-after-fence-failure",
        taskId: submitted.task.taskId,
      }),
    ).rejects.toMatchObject({ code: "storage_unavailable" });

    await fixture.close();
  });
});
