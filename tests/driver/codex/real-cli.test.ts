import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCodexDriver } from "../../../src/driver/codex/driver.js";
import type { DriverEvent } from "../../../src/driver/types.js";

/**
 * 只在本機有已登入的 `codex` 時才跑：`AGENTPORT_REAL_CLI=1 pnpm vitest run
 * tests/driver/codex/real-cli.test.ts`。CI 與一般 `pnpm check` 一律 skip；
 * suite 名稱帶執行方式，`pnpm vitest run` 的 skip 清單就能看到怎麼打開它。
 */
describe.skipIf(process.env.AGENTPORT_REAL_CLI !== "1")(
  "createCodexDriver 真 CLI (set AGENTPORT_REAL_CLI=1 to run)",
  () => {
    let workspace: string;

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
        throw new Error(
          `expected a started event, got: ${JSON.stringify(events)}`,
        );
      }
      return started;
    }

    beforeEach(async () => {
      // 刻意不 git init：驗證非 git 目錄靠 `--skip-git-repo-check` 也能跑。
      workspace = await mkdtemp(join(tmpdir(), "agentport-codex-real-"));
    });

    afterEach(async () => {
      await rm(workspace, { recursive: true, force: true });
    });

    it("start 在非 git 目錄寫檔並 completed；resume 記得前文", async () => {
      const driver = createCodexDriver({ command: "codex", env: process.env });

      const startEvents = await collect(
        driver.start({
          workspace,
          prompt: "在 hello.txt 寫入 hi，然後回覆 done",
          policy: "workspace-write",
          extra_args: [],
        }).events,
      );

      expect(startEvents.some((event) => event.type === "failed")).toBe(false);
      const completed = startEvents.find((event) => event.type === "completed");
      expect(completed).toMatchObject({ type: "completed" });

      const helloContent = await readFile(join(workspace, "hello.txt"), "utf8");
      expect(helloContent).toContain("hi");

      const threadId = findStarted(startEvents).runtime_session_id;

      const resumeEvents = await collect(
        driver.resume({
          workspace,
          prompt: "剛才寫了什麼檔案",
          policy: "workspace-write",
          extra_args: [],
          runtime_session_id: threadId,
        }).events,
      );

      expect(resumeEvents.some((event) => event.type === "failed")).toBe(false);
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
