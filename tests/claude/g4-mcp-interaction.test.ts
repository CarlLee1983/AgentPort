import { execFile, spawnSync } from "node:child_process";
import { chmod, chown, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
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
    const coreDataPath = requiredEnvironment("AGENTPORT_G1_CORE_DATA_PATH");
    const workspacePath = requiredEnvironment("AGENTPORT_G1_WORKSPACE_PATH");
    const daemonUser = requiredEnvironment("AGENTPORT_G1_DAEMON_USER");
    const runtimeGroupId = Number(
      requiredEnvironment("AGENTPORT_G1_RUNTIME_GID"),
    );
    const ingressGroupId = Number(
      requiredEnvironment("AGENTPORT_G1_INGRESS_GID"),
    );
    await stat(workspacePath);
    const daemon = await accountIdentity(daemonUser);
    const base = await mkdtemp(join(coreDataPath, "g4-interaction-"));
    const ingressDirectory = join(base, "ingress");
    const databaseDirectory = join(base, "db");
    try {
      // Root-only fixture preparation (ADR-0006): the launcher-owned ingress
      // directory stays root:ingressGroup 0771; the SQLite directory is
      // owned by the daemon account so the composition never needs root
      // itself (R1).
      // mkdtemp creates the base 0700; the daemon and Runtime identities
      // must traverse it to reach the ingress and database directories.
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
