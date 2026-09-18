import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createControlledRuntimeAdmission,
  hasProtectedLauncherSocketMetadata,
  runtimeUmaskDeniesOtherWrite,
  type ControlledRuntimeAdmissionConfiguration,
} from "../../src/bootstrap/create-controlled-runtime-admission.js";

const UNPROTECTED_INGRESS =
  "Worker ingress directory is not protected for the Runtime identity";

function configuration(
  launcher: Partial<ControlledRuntimeAdmissionConfiguration["launcher"]> = {},
  continuationEncryptionKey: string | null = "test-continuation-key",
): ControlledRuntimeAdmissionConfiguration {
  return {
    registry: { credentials: {}, principals: [], agents: [] },
    cursorSecret: "test-cursor-secret",
    storage: {
      databasePath: "/unreached/agentport.sqlite",
      ...(continuationEncryptionKey === null
        ? {}
        : { continuationEncryptionKey }),
    },
    launcher: {
      socketPath: "/unreached/launcher.sock",
      workerIngressDirectory: "/unreached/ingress",
      socketGroupId: 4,
      runtimeGroupId: 5,
      ingressGroupId: 6,
      ...launcher,
    },
  };
}

describe("controlled Runtime composition", () => {
  const platform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.spyOn(process, "getuid").mockReturnValue(995);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    vi.restoreAllMocks();
  });

  it("refuses to run as uid 0 before any other check (R1)", async () => {
    vi.spyOn(process, "getuid").mockReturnValue(0);
    await expect(
      createControlledRuntimeAdmission(configuration({}, null)),
    ).rejects.toThrow("Controlled Runtime composition must not run as root");
  });

  it("fails before Runtime admission when the continuation key is absent", async () => {
    await expect(
      createControlledRuntimeAdmission(configuration({}, null)),
    ).rejects.toThrow(
      "Controlled Runtime composition requires continuationEncryptionKey",
    );
  });

  it("fails closed when the ingress and Runtime groups are the same id (R5)", async () => {
    await expect(
      createControlledRuntimeAdmission(
        configuration({ runtimeGroupId: 5, ingressGroupId: 5 }),
      ),
    ).rejects.toThrow(
      "Controlled Runtime composition requires distinct ingress, socket and Runtime groups",
    );
  });

  it("refuses a stale or unrelated launcher socket group before reporting it ready", () => {
    const launcher = configuration().launcher;
    expect(
      hasProtectedLauncherSocketMetadata(
        { isSocket: () => true, uid: 0, gid: 99, mode: 0o140660 },
        launcher,
      ),
    ).toBe(false);
    expect(
      hasProtectedLauncherSocketMetadata(
        {
          isSocket: () => true,
          uid: 0,
          gid: launcher.socketGroupId,
          mode: 0o140660,
        },
        launcher,
      ),
    ).toBe(true);
  });

  describe("with an unprotected ingress directory (AC-04)", () => {
    let base: string;

    beforeEach(async () => {
      base = await mkdtemp(join(tmpdir(), "agentport-ap021-ingress-"));
    });

    afterEach(async () => {
      await rm(base, { recursive: true, force: true });
    });

    async function rejection(workerIngressDirectory: string) {
      const error = await createControlledRuntimeAdmission(
        configuration({
          workerIngressDirectory,
          // Unreachable: an ingress rejection must precede any launcher contact.
          socketPath: join(base, "absent", "launcher.sock"),
        }),
      ).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(UNPROTECTED_INGRESS);
      return (error as Error).cause as { ok: false; reason: string };
    }

    it("rejects a missing directory", async () => {
      await expect(rejection(join(base, "missing"))).resolves.toEqual({
        ok: false,
        reason: "missing",
      });
    });

    it("rejects a symlinked directory without following it", async () => {
      const real = join(base, "real");
      const link = join(base, "ingress");
      await mkdir(real, { mode: 0o771 });
      await symlink(real, link);
      await expect(rejection(link)).resolves.toEqual({
        ok: false,
        reason: "not_directory",
      });
    });

    it("rejects a directory with the wrong owner, group or mode", async () => {
      const directory = join(base, "ingress");
      await mkdir(directory, { mode: 0o700 });
      const cause = await rejection(directory);
      expect(["wrong_owner", "wrong_group", "wrong_mode"]).toContain(
        cause.reason,
      );
    });

    it("rejects a relative or non-normalized directory", async () => {
      await expect(
        createControlledRuntimeAdmission(
          configuration({ workerIngressDirectory: `${base}/./ingress` }),
        ),
      ).rejects.toThrow(UNPROTECTED_INGRESS);
    });
  });
});

describe("controlled Runtime umask gate", () => {
  it.each([
    ["0022", true],
    ["0002", true],
    ["0020", false],
    ["0000", false],
  ])("interprets Umask %s", (umask, expected) => {
    expect(
      runtimeUmaskDeniesOtherWrite(`Name:\tnode\nUmask:\t${umask}\n`),
    ).toBe(expected);
  });

  it("fails closed when Linux does not report a process umask", () => {
    expect(runtimeUmaskDeniesOtherWrite("Name:\tnode\n")).toBe(false);
  });
});
