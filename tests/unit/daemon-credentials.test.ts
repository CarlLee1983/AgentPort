import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
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
        join(await realpath(tmpdir()), "agentport-credentials-"),
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
});
