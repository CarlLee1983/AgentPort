import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";
import { AgentRegistry } from "../../src/bootstrap/registry.js";
import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";

const ACTOR = { principalId: "principal-a" };

async function revokeBeforeCommit(
  fixture: Awaited<ReturnType<typeof createDurableAdmissionFixture>>,
  pending: Promise<unknown>,
): Promise<void> {
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
}

describe("Registry revision fence", () => {
  it("persists the production Registry high-water revision across restart", async () => {
    const fixture = await createDurableAdmissionFixture();
    let reopened: SqliteDurableAdmissionStore | undefined;
    try {
      const current = {
        ...fixture.registryConfiguration,
        registryRevision: 4,
      };
      await AgentRegistry.create(current, fixture.store);
      await fixture.store.close();
      reopened = await SqliteDurableAdmissionStore.open({
        databasePath: fixture.databasePath,
      });
      await expect(
        AgentRegistry.create({ ...current, registryRevision: 3 }, reopened),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      await expect(
        AgentRegistry.create(
          {
            ...current,
            registryRevision: 4,
            principals: current.principals.map((principal) =>
              principal.principalId === "principal-a"
                ? { ...principal, active: false }
                : principal,
            ),
          },
          reopened,
        ),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      await expect(
        AgentRegistry.create({ ...current, registryRevision: 4 }, reopened),
      ).resolves.toBeDefined();
    } finally {
      await reopened?.close();
      await fixture.close();
    }
  });

  it("rolls back an in-flight edit and leaves no receipt after membership revocation", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const submitted = await fixture.service.submitTask(ACTOR, {
        operationId: "edit-revocation-submit",
        agentId: "agent-a",
        instruction: "original instruction",
      });
      const input = {
        operationId: "edit-revocation-race",
        taskId: submitted.task.taskId,
        expectedRevision: submitted.task.revision,
        instruction: "must not commit after revocation",
      };
      await fixture.store.probe("armCommitBarrier");
      const pending = fixture.service.editTask(ACTOR, input);
      await revokeBeforeCommit(fixture, pending);
      await expect(
        fixture.store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        revision: submitted.task.revision,
        instruction: "original instruction",
      });
      await fixture.registry.replace(fixture.registryConfiguration);
      await expect(
        fixture.service.editTask(ACTOR, input),
      ).resolves.toMatchObject({
        replayed: false,
        task: { revision: submitted.task.revision + 1 },
      });
    } finally {
      await fixture.store.probe("releaseCommitBarrier").catch(() => undefined);
      await fixture.close();
    }
  });

  it("rolls back an in-flight first answer and leaves no receipt after membership revocation", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const submitted = await fixture.service.submitTask(ACTOR, {
        operationId: "reply-revocation-submit",
        agentId: "agent-a",
        instruction: "Ask for one answer",
      });
      const { reference } = await fixture.service.prepareForDispatch(
        submitted.task.taskId,
        "reply-revocation-epoch",
      );
      await fixture.service.markExecutionRunning(reference);
      await fixture.store.persistQuestionObservation({
        reference,
        questionId: "reply-revocation-question",
        toolUseId: "reply-revocation-tool",
        requestId: "reply-revocation-request",
        ordinal: 1,
        toolActivity: "none",
        activeElapsedMs: 0,
        schema: [
          {
            question: "Choose a color",
            header: "Color",
            options: [
              { label: "Blue", description: "Use blue" },
              { label: "Red", description: "Use red" },
            ],
            multiSelect: false,
          },
        ],
        expiresAt: "2026-09-15T00:00:00.000Z",
        now: "2026-09-14T00:00:00.000Z",
      });
      const input = {
        operationId: "reply-revocation-race",
        taskId: submitted.task.taskId,
        questionId: "reply-revocation-question",
        answer: { "Choose a color": "Blue" },
      };
      await fixture.store.probe("armCommitBarrier");
      const pending = fixture.service.reply(ACTOR, input);
      await revokeBeforeCommit(fixture, pending);
      await expect(
        fixture.store.getTaskProjection({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        question: { state: "pending", answer: null },
      });
      await fixture.registry.replace(fixture.registryConfiguration);
      await expect(fixture.service.reply(ACTOR, input)).resolves.toMatchObject({
        replayed: false,
        task: { question: { state: "accepted" } },
      });
    } finally {
      await fixture.store.probe("releaseCommitBarrier").catch(() => undefined);
      await fixture.close();
    }
  });

  it("rolls back an in-flight Context resume and leaves its blocker intact after membership revocation", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const predecessor = await fixture.service.submitTask(ACTOR, {
        operationId: "resume-revocation-predecessor",
        agentId: "agent-a",
        instruction: "Cancel before a follow-up",
      });
      const successor = await fixture.service.submitTask(ACTOR, {
        operationId: "resume-revocation-successor",
        agentId: "agent-a",
        contextId: predecessor.task.contextId,
        instruction: "Do not unblock under revoked membership",
      });
      await fixture.service.cancelTask(ACTOR, {
        operationId: "resume-revocation-cancel",
        taskId: predecessor.task.taskId,
      });
      const blocked = await fixture.service.getTask(ACTOR, {
        taskId: successor.task.taskId,
      });
      expect(blocked).toMatchObject({ state: "paused", blocker: {} });
      const input = {
        operationId: "resume-revocation-race",
        contextId: predecessor.task.contextId,
        expectedRevision: blocked.contextRevision,
        continuationMode: "fresh_session" as const,
        contextSummary: "Explicitly resume after the canceled predecessor",
      };
      await fixture.store.probe("armCommitBarrier");
      const pending = fixture.service.resumeContext(ACTOR, input);
      await revokeBeforeCommit(fixture, pending);
      await expect(
        fixture.store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: successor.task.taskId,
        }),
      ).resolves.toMatchObject({ state: "paused", blocker: {} });
      await fixture.registry.replace(fixture.registryConfiguration);
      await expect(
        fixture.service.resumeContext(ACTOR, input),
      ).resolves.toMatchObject({
        replayed: false,
        task: { state: "queued", blocker: null },
      });
    } finally {
      await fixture.store.probe("releaseCommitBarrier").catch(() => undefined);
      await fixture.close();
    }
  });

  it("rolls back an in-flight interruption acknowledgement after membership revocation", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const submitted = await fixture.service.submitTask(ACTOR, {
        operationId: "ack-revocation-submit",
        agentId: "agent-revokable",
        instruction: "Recover before acknowledgement",
      });
      const { reference } = await fixture.service.prepareForDispatch(
        submitted.task.taskId,
        "ack-revocation-epoch",
      );
      await fixture.service.markExecutionRunning(reference);
      await fixture.store.recoverExecutions();
      const recovering = await fixture.service.getTask(ACTOR, {
        taskId: submitted.task.taskId,
      });
      expect(recovering).toMatchObject({ state: "recovering" });
      await fixture.store.confirmRecoveryStopped({
        evidence: {
          platform: "linux-cgroup-v2",
          reference,
          executionUnitId: "ack-revocation-unit",
          generationSealedAt: "2026-09-14T00:00:01.000Z",
          unitEmptyObservedAt: "2026-09-14T00:00:02.000Z",
        },
        now: "2026-09-14T00:00:03.000Z",
      });
      const input = {
        operationId: "ack-revocation-race",
        taskId: submitted.task.taskId,
        expectedRevision: recovering.revision,
      };
      await fixture.store.probe("armCommitBarrier");
      const pending = fixture.service.acknowledgeInterruption(ACTOR, input);
      await revokeBeforeCommit(fixture, pending);
      await expect(
        fixture.store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-revokable"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({ state: "recovering" });
      await fixture.registry.replace(fixture.registryConfiguration);
      await expect(
        fixture.service.acknowledgeInterruption(ACTOR, input),
      ).resolves.toMatchObject({
        replayed: false,
        task: { state: "interrupted" },
      });
    } finally {
      await fixture.store.probe("releaseCommitBarrier").catch(() => undefined);
      await fixture.close();
    }
  });
  it("fences a replayed submit before returning its receipt after membership revocation", async () => {
    const fixture = await createDurableAdmissionFixture();
    const input = {
      operationId: "replayed-submit-membership-race",
      agentId: "agent-a",
      instruction: "must not replay after membership is revoked",
    };
    try {
      await fixture.service.submitTask(ACTOR, input);
      await fixture.store.probe("armCommitBarrier");
      const replay = fixture.service.submitTask(ACTOR, input);
      const first = await Promise.race([
        replay.then(
          () => "replay" as const,
          () => "replay" as const,
        ),
        fixture.store
          .probe("waitForCommitBarrier")
          .then(() => "barrier" as const),
      ]);
      expect(first).toBe("barrier");

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

      await expect(replay).rejects.toMatchObject({
        code: "storage_unavailable",
        retryable: true,
      });
      await replacement;
    } finally {
      await fixture.store.probe("releaseCommitBarrier").catch(() => undefined);
      await fixture.close();
    }
  });

  it("fences a replayed cancel before returning its receipt after membership revocation", async () => {
    const fixture = await createDurableAdmissionFixture();
    const submitted = await fixture.service.submitTask(ACTOR, {
      operationId: "replayed-cancel-membership-race-submit",
      agentId: "agent-a",
      instruction: "must not expose a canceled receipt after revocation",
    });
    const input = {
      operationId: "replayed-cancel-membership-race",
      taskId: submitted.task.taskId,
    };
    try {
      await fixture.service.cancelTask(ACTOR, input);
      await fixture.store.probe("armCommitBarrier");
      const replay = fixture.service.cancelTask(ACTOR, input);
      const first = await Promise.race([
        replay.then(
          () => "replay" as const,
          () => "replay" as const,
        ),
        fixture.store
          .probe("waitForCommitBarrier")
          .then(() => "barrier" as const),
      ]);
      expect(first).toBe("barrier");

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

      await expect(replay).rejects.toMatchObject({
        code: "storage_unavailable",
        retryable: true,
      });
      await replacement;
    } finally {
      await fixture.store.probe("releaseCommitBarrier").catch(() => undefined);
      await fixture.close();
    }
  });

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
