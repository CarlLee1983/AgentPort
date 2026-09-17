import { describe, expect, it, vi } from "vitest";

import {
  assessProtectedIngressDirectory,
  ensureLauncherIngressDirectory,
  type IngressDirectoryObservation,
} from "../../src/supervisor/linux/ingress-directory.js";

const protectedAncestor = {
  path: "/run/agentport-g1",
  isDirectory: true,
  isSymbolicLink: false,
  uid: 0,
  mode: 0o750,
};

const protectedTarget = {
  isDirectory: true,
  isSymbolicLink: false,
  uid: 0,
  gid: 989,
  mode: 0o771,
};

const expected = { ingressGroupId: 989, allowRootProcess: false };

describe("assessProtectedIngressDirectory", () => {
  it("accepts a protected root-owned 0771 directory with protected ancestors", () => {
    expect(
      assessProtectedIngressDirectory(
        {
          processUid: 997,
          target: protectedTarget,
          ancestors: [protectedAncestor],
        },
        expected,
      ),
    ).toEqual({ ok: true });
  });

  it("rejects a root process only when root is disallowed", () => {
    expect(
      assessProtectedIngressDirectory(
        {
          processUid: 0,
          target: protectedTarget,
          ancestors: [protectedAncestor],
        },
        expected,
      ),
    ).toEqual({ ok: false, reason: "process_is_root" });
    expect(
      assessProtectedIngressDirectory(
        {
          processUid: 0,
          target: protectedTarget,
          ancestors: [protectedAncestor],
        },
        { ingressGroupId: 989, allowRootProcess: true },
      ),
    ).toEqual({ ok: true });
  });

  it("rejects a missing directory", () => {
    expect(
      assessProtectedIngressDirectory(
        { processUid: 997, target: undefined, ancestors: [protectedAncestor] },
        expected,
      ),
    ).toEqual({ ok: false, reason: "missing" });
  });

  it.each([
    ["a symlink", { ...protectedTarget, isSymbolicLink: true }],
    ["a non-directory", { ...protectedTarget, isDirectory: false }],
  ])("rejects %s as not_directory", (_label, target) => {
    expect(
      assessProtectedIngressDirectory(
        { processUid: 997, target, ancestors: [protectedAncestor] },
        expected,
      ),
    ).toEqual({ ok: false, reason: "not_directory" });
  });

  it("rejects a wrong owner", () => {
    expect(
      assessProtectedIngressDirectory(
        {
          processUid: 997,
          target: { ...protectedTarget, uid: 997 },
          ancestors: [protectedAncestor],
        },
        expected,
      ),
    ).toEqual({ ok: false, reason: "wrong_owner" });
  });

  it("rejects a wrong group", () => {
    expect(
      assessProtectedIngressDirectory(
        {
          processUid: 997,
          target: { ...protectedTarget, gid: 990 },
          ancestors: [protectedAncestor],
        },
        expected,
      ),
    ).toEqual({ ok: false, reason: "wrong_group" });
  });

  it.each([
    ["0770", 0o770],
    ["0755", 0o755],
    ["0700", 0o700],
  ])("rejects mode %s as wrong_mode", (_label, mode) => {
    expect(
      assessProtectedIngressDirectory(
        {
          processUid: 997,
          target: { ...protectedTarget, mode },
          ancestors: [protectedAncestor],
        },
        expected,
      ),
    ).toEqual({ ok: false, reason: "wrong_mode" });
  });

  it.each([
    ["a symlinked ancestor", [{ ...protectedAncestor, isSymbolicLink: true }]],
    [
      "a non-directory ancestor",
      [{ ...protectedAncestor, isDirectory: false }],
    ],
    ["a non-root-owned ancestor", [{ ...protectedAncestor, uid: 997 }]],
    ["a group-writable ancestor", [{ ...protectedAncestor, mode: 0o770 }]],
    ["an other-writable ancestor", [{ ...protectedAncestor, mode: 0o757 }]],
  ])("rejects %s as unprotected_ancestor", (_label, ancestors) => {
    expect(
      assessProtectedIngressDirectory(
        { processUid: 997, target: protectedTarget, ancestors },
        expected,
      ),
    ).toEqual({ ok: false, reason: "unprotected_ancestor" });
  });
});

describe("ensureLauncherIngressDirectory (AP-021 R2)", () => {
  const launcherUid = 0;

  function observation(
    target: IngressDirectoryObservation["target"],
  ): IngressDirectoryObservation {
    return {
      processUid: launcherUid,
      target,
      ancestors: [protectedAncestor],
    };
  }

  it("verifies an existing protected directory without creating or repairing it", async () => {
    const create = vi.fn(() => Promise.resolve());
    await ensureLauncherIngressDirectory(
      989,
      () => Promise.resolve(observation(protectedTarget)),
      create,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["a symlink", { ...protectedTarget, isSymbolicLink: true }],
    ["the wrong owner", { ...protectedTarget, uid: 997 }],
    ["the wrong group", { ...protectedTarget, gid: 988 }],
    ["the wrong mode", { ...protectedTarget, mode: 0o770 }],
  ])(
    "refuses an existing directory with %s before any creation",
    async (_label, target) => {
      const create = vi.fn(() => Promise.resolve());
      await expect(
        ensureLauncherIngressDirectory(
          989,
          () => Promise.resolve(observation(target)),
          create,
        ),
      ).rejects.toThrow("Launcher ingress directory is not protected");
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("creates a missing directory and re-verifies what was created", async () => {
    const observations = [observation(undefined), observation(protectedTarget)];
    const create = vi.fn(() => Promise.resolve());
    await ensureLauncherIngressDirectory(
      989,
      () => Promise.resolve(observations.shift() ?? observation(undefined)),
      create,
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(observations).toEqual([]);
  });

  it("refuses when the created directory still does not verify", async () => {
    await expect(
      ensureLauncherIngressDirectory(
        989,
        () => Promise.resolve(observation(undefined)),
        () => Promise.resolve(),
      ),
    ).rejects.toThrow("Launcher ingress directory is not protected");
  });
});
