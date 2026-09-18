import { execFile, spawnSync } from "node:child_process";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  stat,
} from "node:fs/promises";
import { release } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { requiredEnvironment } from "../fixtures/linux-supervisor.js";

const executeFile = promisify(execFile);

const G4_ENABLED =
  process.platform === "linux" &&
  process.env["AGENTPORT_G1_LINUX"] === "1" &&
  process.env["AGENTPORT_G1_CLAUDE"] === "1";

function evidence(outcome: "OK" | "FAILED", states: readonly string[]): string {
  return `G4_CLAUDE_INTERACTION_${outcome} ${JSON.stringify({
    platform: process.platform,
    kernel: release(),
    node: process.version,
    candidateRevision: requiredEnvironment("AGENTPORT_G1_CANDIDATE_REVISION"),
    candidateDirectory: basename(process.cwd()),
    states,
  })}\n`;
}

async function accountIdentity(
  name: string,
): Promise<{ uid: number; gid: number }> {
  const [uid, gid] = await Promise.all([
    executeFile("id", ["-u", name]),
    executeFile("id", ["-g", name]),
  ]);
  return { uid: Number(uid.stdout.trim()), gid: Number(gid.stdout.trim()) };
}

describe.skipIf(!G4_ENABLED)("real Claude interaction through MCP", () => {
  it("runs the native Question and continuation interaction as the non-root daemon account", async () => {
    const fixtureRoot = requiredEnvironment("AGENTPORT_G1_G4_FIXTURE_ROOT");
    const workspacePath = requiredEnvironment("AGENTPORT_G1_WORKSPACE_PATH");
    const daemonUser = requiredEnvironment("AGENTPORT_G1_DAEMON_USER");
    const runtimeGroupId = Number(
      requiredEnvironment("AGENTPORT_G1_RUNTIME_GID"),
    );
    const ingressGroupId = Number(
      requiredEnvironment("AGENTPORT_G1_INGRESS_GID"),
    );
    const [fixtureRootMetadata] = await Promise.all([
      lstat(fixtureRoot),
      stat(workspacePath),
    ]);
    expect(fixtureRootMetadata.isDirectory()).toBe(true);
    expect(fixtureRootMetadata.isSymbolicLink()).toBe(false);
    expect(fixtureRootMetadata.uid).toBe(0);
    expect(fixtureRootMetadata.gid).toBe(0);
    expect(fixtureRootMetadata.mode & 0o777).toBe(0o711);
    const daemon = await accountIdentity(daemonUser);
    // Keep the child ingress socket below the launcher protocol's 96-byte
    // endpoint bound while retaining the dedicated G4 fixture root.
    const base = await mkdtemp(join(fixtureRoot, "g4-"));
    const ingressDirectory = join(base, "ingress");
    const databaseDirectory = join(base, "db");
    expect(
      Buffer.byteLength(
        join(base, "ingress", `${"0".repeat(36)}.sock`),
        "utf8",
      ),
    ).toBeLessThanOrEqual(96);
    try {
      // Root-only fixture preparation (ADR-0006): the launcher-owned ingress
      // directory stays root:ingressGroup 0771; the SQLite directory is
      // owned by the daemon account so the composition never needs root
      // itself (R1).
      // GATE-054 keeps core data root-only. The dedicated fixture root and
      // this base are traverse-only so the daemon can reach its own ingress
      // and database directories without gaining core-data access.
      await chmod(base, 0o711);
      await mkdir(ingressDirectory);
      await chown(ingressDirectory, 0, ingressGroupId);
      await chmod(ingressDirectory, 0o771);
      await mkdir(databaseDirectory);
      await chown(databaseDirectory, daemon.uid, daemon.gid);
      await chmod(databaseDirectory, 0o700);

      const child = spawnSync(
        "runuser",
        [
          "-u",
          daemonUser,
          "--",
          "/usr/bin/env",
          "-i",
          `AGENTPORT_G1_INGRESS_DIRECTORY=${ingressDirectory}`,
          `AGENTPORT_G1_DATABASE_PATH=${join(databaseDirectory, "agentport-g4.sqlite")}`,
          `AGENTPORT_G1_LAUNCHER_SOCKET=${requiredEnvironment("AGENTPORT_G1_LAUNCHER_SOCKET")}`,
          `AGENTPORT_G1_RUNTIME_GID=${String(runtimeGroupId)}`,
          `AGENTPORT_G1_INGRESS_GID=${String(ingressGroupId)}`,
          `AGENTPORT_G1_WORKSPACE_PATH=${workspacePath}`,
          "PATH=/usr/local/bin:/usr/bin:/bin",
          process.execPath,
          join(
            process.cwd(),
            "dist-fixtures/tests/fixtures/g4-daemon-child.js",
          ),
        ],
        { encoding: "utf8", timeout: 480_000, maxBuffer: 16 * 1024 * 1024 },
      );
      if (child.error) throw child.error;
      const lastLine = child.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .at(-1);
      if (lastLine === undefined) {
        throw new Error("G4 daemon child produced no observation");
      }
      const observation = JSON.parse(lastLine) as {
        outcome: "OK" | "FAILED";
        processUid: number;
        states: string[];
      };
      expect(observation.processUid).toBeGreaterThan(0);
      process.stdout.write(evidence(observation.outcome, observation.states));
      if (observation.outcome !== "OK" || child.status !== 0) {
        throw new Error("G4 daemon child did not complete the interaction");
      }
      expect(observation.states).toEqual([
        "question_pending",
        "answer_accepted_delivery_pending",
        "question_task_completed",
        "blocker_question_pending",
        "blocker_canceled",
        "successor_paused",
        "fresh_continuation_queued",
        "fresh_continuation_completed",
      ]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }, 480_000);
});
