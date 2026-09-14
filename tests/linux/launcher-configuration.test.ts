import {
  chmod,
  chown,
  mkdtemp,
  readFile,
  rm,
  mkdir,
  symlink,
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
        ).rejects.toThrow("unsafe ancestor");
      } finally {
        await chmod(unsafe, 0o700).catch(() => undefined);
        await rm(unsafe, { recursive: true, force: true });
      }
    });
  },
);
