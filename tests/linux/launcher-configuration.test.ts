import { randomUUID } from "node:crypto";
import {
  chmod,
  chown,
  lstat,
  mkdtemp,
  readFile,
  rm,
  mkdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { readProtectedLinuxLauncherOptions } from "../../src/supervisor/linux/launcher-configuration.js";
import { prepareProtectedLauncherDirectory } from "../../src/supervisor/linux/protected-path.js";
import {
  LINUX_G1_ENABLED,
  requiredEnvironment,
} from "../fixtures/linux-supervisor.js";

describe.skipIf(!LINUX_G1_ENABLED)(
  "protected Linux launcher configuration",
  () => {
    it("loads the designated root-owned non-writable configuration", async () => {
      await expect(
        readProtectedLinuxLauncherOptions(
          requiredEnvironment("AGENTPORT_G1_LAUNCHER_CONFIG"),
        ),
      ).resolves.toMatchObject({
        socketPath: requiredEnvironment("AGENTPORT_G1_LAUNCHER_SOCKET"),
        ledgerDirectory: requiredEnvironment("AGENTPORT_G1_LEDGER_DIRECTORY"),
      });
    });

    it("rejects symlinked, writable, and non-root configuration files", async () => {
      const designated = requiredEnvironment("AGENTPORT_G1_LAUNCHER_CONFIG");
      const directory = await mkdtemp(
        join(
          dirname(requiredEnvironment("AGENTPORT_G1_LEDGER_DIRECTORY")),
          "configuration-test-",
        ),
      );
      const configuration = join(directory, "launcher.json");
      const link = join(directory, "launcher-link.json");
      try {
        await writeFile(configuration, await readFile(designated), {
          mode: 0o600,
        });
        await expect(
          readProtectedLinuxLauncherOptions(configuration),
        ).resolves.toBeDefined();

        await chmod(configuration, 0o620);
        await expect(
          readProtectedLinuxLauncherOptions(configuration),
        ).rejects.toThrow("Launcher configuration file is not protected");

        await chmod(configuration, 0o600);
        await chown(
          configuration,
          Number(requiredEnvironment("AGENTPORT_G1_RUNTIME_UID")),
          Number(requiredEnvironment("AGENTPORT_G1_RUNTIME_GID")),
        );
        await expect(
          readProtectedLinuxLauncherOptions(configuration),
        ).rejects.toThrow("Launcher configuration file is not protected");

        await chown(configuration, 0, 0);
        await symlink(configuration, link);
        await expect(
          readProtectedLinuxLauncherOptions(link),
        ).rejects.toBeDefined();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it.each([0o000, 0o002])(
      "prepares and re-prepares a 0771 ingress-style directory with umask %s (C1)",
      async (umask) => {
        const parent = dirname(
          requiredEnvironment("AGENTPORT_G1_LEDGER_DIRECTORY"),
        );
        const target = join(parent, `ingress-style-0771-${umask.toString(8)}`);
        const ingressGroupId = Number(
          requiredEnvironment("AGENTPORT_G1_INGRESS_GID"),
        );
        const previousUmask = process.umask(umask);
        try {
          await prepareProtectedLauncherDirectory(
            target,
            0o771,
            ingressGroupId,
          );
          await prepareProtectedLauncherDirectory(
            target,
            0o771,
            ingressGroupId,
          );
          const metadata = await lstat(target);
          expect(metadata.uid).toBe(0);
          expect(metadata.gid).toBe(ingressGroupId);
          expect(metadata.mode & 0o777).toBe(0o771);
        } finally {
          process.umask(previousUmask);
          await rm(target, { recursive: true, force: true });
        }
      },
    );

    it("refuses an ingress directory symlinked to /tmp without following it (AP-021 security matrix)", async () => {
      const parent = dirname(
        requiredEnvironment("AGENTPORT_G1_LEDGER_DIRECTORY"),
      );
      const link = join(parent, `ingress-symlink-${randomUUID()}`);
      await symlink("/tmp", link);
      try {
        const before = await lstat("/tmp");
        await expect(
          prepareProtectedLauncherDirectory(link, 0o771, 0),
        ).rejects.toThrow("target is unsafe");
        const after = await lstat("/tmp");
        expect(after.uid).toBe(before.uid);
        expect(after.gid).toBe(before.gid);
        expect(after.mode).toBe(before.mode);
      } finally {
        await unlink(link);
      }
    });

    it("refuses, rather than repairs, an existing target owned by the Runtime identity (AP-021 R2)", async () => {
      const parent = dirname(
        requiredEnvironment("AGENTPORT_G1_LEDGER_DIRECTORY"),
      );
      const target = join(parent, `runtime-owned-${randomUUID()}`);
      const runtimeUid = Number(
        requiredEnvironment("AGENTPORT_G1_RUNTIME_UID"),
      );
      await mkdir(target, { mode: 0o700 });
      await chown(target, runtimeUid, 0);
      try {
        await expect(
          prepareProtectedLauncherDirectory(target, 0o771, 0),
        ).rejects.toThrow("target is unsafe");
        expect((await lstat(target)).uid).toBe(runtimeUid);
      } finally {
        await rm(target, { recursive: true, force: true });
      }
    });

    it("refuses to create a privileged path below a writable ancestor", async () => {
      const parent = dirname(
        requiredEnvironment("AGENTPORT_G1_LEDGER_DIRECTORY"),
      );
      const unsafe = await mkdtemp(join(parent, "unsafe-launcher-path-"));
      const target = join(unsafe, "ledger");
      try {
        await chmod(unsafe, 0o777);
        await expect(
          prepareProtectedLauncherDirectory(target, 0o700, 0),
        ).rejects.toThrow("unsafe ancestor");

        await chmod(unsafe, 0o700);
        await mkdir(target, { mode: 0o700 });
        const link = join(unsafe, "linked-ledger");
        await symlink(target, link);
        await expect(
          prepareProtectedLauncherDirectory(link, 0o700, 0),
        ).rejects.toThrow("target is unsafe");
      } finally {
        await chmod(unsafe, 0o700).catch(() => undefined);
        await rm(unsafe, { recursive: true, force: true });
      }
    });
  },
);
