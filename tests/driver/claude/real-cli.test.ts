import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createClaudeDriver } from "../../../src/driver/claude/driver.js";
import type { DriverEvent } from "../../../src/driver/types.js";
import { initGitWorkspace } from "../../helpers/git.js";

/**
 * 只在本機有已登入的 `claude` 時才跑：`AGENTPORT_REAL_CLI=1 pnpm vitest run
 * tests/driver/claude/real-cli.test.ts`。CI 與一般 `pnpm check` 一律 skip；
 * suite 名稱帶執行方式，`pnpm vitest run` 的 skip 清單就能看到怎麼打開它。
 */
async function collect(
  events: AsyncIterable<DriverEvent>,
): Promise<DriverEvent[]> {
  const seen: DriverEvent[] = [];
  for await (const event of events) {
    seen.push(event);
  }
  return seen;
}

function findStarted(
  events: DriverEvent[],
): Extract<DriverEvent, { type: "started" }> {
  const started = events.find((event) => event.type === "started");
  if (!started) {
    throw new Error(`expected a started event, got: ${JSON.stringify(events)}`);
  }
  return started;
}

describe.skipIf(process.env.AGENTPORT_REAL_CLI !== "1")(
  "createClaudeDriver 真 CLI (set AGENTPORT_REAL_CLI=1 to run)",
  () => {
    let workspace: string;

    beforeEach(async () => {
      workspace = await mkdtemp(join(tmpdir(), "agentport-claude-real-"));
      await initGitWorkspace(workspace);
    });

    afterEach(async () => {
      await rm(workspace, { recursive: true, force: true });
    });

    it("start 寫檔並 completed；resume 記得前文", async () => {
      const driver = createClaudeDriver({
        command: "claude",
        env: process.env,
      });

      // 寫進 docs/ 而非 workspace 根目錄：本機 `~/.claude/hooks/write-guard.sh`
      // 這個個人 PreToolUse hook 會擋下根目錄的零散檔案（見 driver 不加
      // `--setting-sources` 的決定，這個 hook 理當生效），docs/ 底下才不受影響。
      const startEvents = await collect(
        driver.start({
          workspace,
          prompt: "在 docs/hello.txt 寫入 hi，然後回覆 done",
          policy: "workspace-write",
          extra_args: [],
        }).events,
      );

      const completed = startEvents.find((event) => event.type === "completed");
      expect(completed).toBeDefined();
      expect(completed).toMatchObject({ type: "completed" });
      expect(startEvents.some((event) => event.type === "failed")).toBe(false);

      const helloContent = await readFile(
        join(workspace, "docs/hello.txt"),
        "utf8",
      );
      expect(helloContent).toContain("hi");

      const sessionId = findStarted(startEvents).runtime_session_id;

      const resumeEvents = await collect(
        driver.resume({
          workspace,
          prompt: "剛才寫了什麼檔案？",
          policy: "workspace-write",
          extra_args: [],
          runtime_session_id: sessionId,
        }).events,
      );

      const resumeCompleted = resumeEvents.find(
        (event) => event.type === "completed",
      );
      expect(resumeCompleted).toBeDefined();
      if (resumeCompleted?.type === "completed") {
        expect(resumeCompleted.final_text).toContain("hello");
      }
    }, 120_000);
  },
);
