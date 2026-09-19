import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DAEMON_CREDENTIAL_ERROR,
  readSystemdDaemonCredentials,
  validateDaemonCredentials,
} from "../../src/daemon/credentials.js";

const continuationKey = randomBytes(32).toString("base64url");

describe("systemd daemon credentials", () => {
  it("accepts the existing cursor and continuation codec contracts", () => {
    expect(
      validateDaemonCredentials(
        "a cursor secret of at least sixteen",
        continuationKey,
      ),
    ).toEqual({
      cursorSecret: "a cursor secret of at least sixteen",
      continuationEncryptionKey: continuationKey,
    });
  });

  it.each([
    ["empty cursor", "", continuationKey],
    ["short cursor", "too-short", continuationKey],
    [
      "wrong key alphabet",
      "a cursor secret of at least sixteen",
      "!".repeat(43),
    ],
    ["wrong key length", "a cursor secret of at least sixteen", "a".repeat(42)],
  ])("rejects %s with no secret-bearing detail", (_label, cursor, key) => {
    expect(() => validateDaemonCredentials(cursor, key)).toThrow(
      DAEMON_CREDENTIAL_ERROR,
    );
  });

  it("rejects a missing credential directory with the same stable code", async () => {
    await expect(readSystemdDaemonCredentials(undefined)).rejects.toThrow(
      DAEMON_CREDENTIAL_ERROR,
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    "loads protected credential files and rejects unsafe modes without repair",
    async () => {
      const directory = await mkdtemp(
        join(await realpath(homedir()), "agentport-credentials-"),
      );
      const cursorPath = join(directory, "cursorSecret");
      const continuationPath = join(directory, "continuationEncryptionKey");
      try {
        await Promise.all([
          writeFile(cursorPath, "a cursor secret of at least sixteen", {
            mode: 0o600,
          }),
          writeFile(continuationPath, continuationKey, { mode: 0o600 }),
        ]);
        await expect(readSystemdDaemonCredentials(directory)).resolves.toEqual({
          cursorSecret: "a cursor secret of at least sixteen",
          continuationEncryptionKey: continuationKey,
        });

        await chmod(cursorPath, 0o640);
        await expect(readSystemdDaemonCredentials(directory)).rejects.toThrow(
          DAEMON_CREDENTIAL_ERROR,
        );
        expect((await stat(cursorPath)).mode & 0o777).toBe(0o640);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "rejects a writable ancestor without repairing it",
    async () => {
      const fixtureRoot = await mkdtemp(
        join(await realpath(homedir()), "agentport-credentials-"),
      );
      const writableAncestor = join(fixtureRoot, "writable-ancestor");
      const directory = join(writableAncestor, "credentials");
      try {
        await mkdir(writableAncestor, { mode: 0o700 });
        await mkdir(directory, { mode: 0o700 });
        await Promise.all([
          writeFile(
            join(directory, "cursorSecret"),
            "a cursor secret of at least sixteen",
            { mode: 0o600 },
          ),
          writeFile(
            join(directory, "continuationEncryptionKey"),
            continuationKey,
            {
              mode: 0o600,
            },
          ),
        ]);
        await chmod(writableAncestor, 0o770);

        await expect(readSystemdDaemonCredentials(directory)).rejects.toThrow(
          DAEMON_CREDENTIAL_ERROR,
        );
        expect((await stat(writableAncestor)).mode & 0o777).toBe(0o770);
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  );
});
