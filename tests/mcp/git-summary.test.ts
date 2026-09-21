import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupTempDirs } from "../config/helpers.js";
import { scriptedDriver } from "../helpers/fake-driver.js";
import { gitCommitAll, initGitWorkspace } from "../helpers/git.js";
import { createTestApp, waitForTaskFinal } from "../helpers/app.js";

afterEach(cleanupTempDirs);

async function submitAndWait(
  app: Awaited<ReturnType<typeof createTestApp>>,
): Promise<Record<string, unknown>> {
  const submitResponse = await app.client.callTool({
    name: "submit_task",
    arguments: { agent: "stationhub", prompt: "do the thing" },
  });
  const { task_id: taskId } = submitResponse.structuredContent as {
    task_id: string;
  };
  return waitForTaskFinal(app.client, taskId);
}

describe("git 摘要", () => {
  it("未 commit 的變更：修改既有檔 + 新增 untracked 檔", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess-1" },
        { type: "completed", final_text: "done", usage: null },
      ],
      onStart: async (input) => {
        await writeFile(
          join(input.workspace, "existing.txt"),
          "changed\n",
          "utf8",
        );
        await writeFile(
          join(input.workspace, "untracked.txt"),
          "new\n",
          "utf8",
        );
      },
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      await initGitWorkspace(app.paths.workspace);

      const task = await submitAndWait(app);
      expect(task.state).toBe("completed");
      expect(task.diff_stat).toContain("existing.txt");
      expect(task.diff_stat).toContain(" untracked: untracked.txt");
      expect(task.commits).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("driver 改檔並 commit 兩次：commits 依舊到新排序", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess-1" },
        { type: "completed", final_text: "done", usage: null },
      ],
      onStart: async (input) => {
        await writeFile(
          join(input.workspace, "existing.txt"),
          "first\n",
          "utf8",
        );
        gitCommitAll(input.workspace, "first change");
        await writeFile(
          join(input.workspace, "existing.txt"),
          "second\n",
          "utf8",
        );
        gitCommitAll(input.workspace, "second change");
      },
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      await initGitWorkspace(app.paths.workspace);

      const task = await submitAndWait(app);
      expect(task.state).toBe("completed");
      const commits = task.commits as { sha: string; subject: string }[];
      expect(commits).toHaveLength(2);
      expect(commits[0]?.subject).toBe("first change");
      expect(commits[1]?.subject).toBe("second change");
      expect(task.diff_stat).toContain("existing.txt");
    } finally {
      await app.close();
    }
  });

  it("沒有任何改動：diff_stat 為空字串、commits 為空陣列", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess-1" },
        { type: "completed", final_text: "done", usage: null },
      ],
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      await initGitWorkspace(app.paths.workspace);

      const task = await submitAndWait(app);
      expect(task.state).toBe("completed");
      expect(task.diff_stat).toBe("");
      expect(task.commits).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("workspace 不是 git repo：completed 但 diff_stat/commits 為 null、hints.git 有原因", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess-1" },
        { type: "completed", final_text: "done", usage: null },
      ],
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      const task = await submitAndWait(app);
      expect(task.state).toBe("completed");
      expect(task.diff_stat).toBeNull();
      expect(task.commits).toBeNull();
      expect((task.hints as { git?: string } | null)?.git).toEqual(
        expect.any(String),
      );
    } finally {
      await app.close();
    }
  });

  it("損壞的 .git（指向不存在的 gitdir）：同非 git 目錄的行為", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess-1" },
        { type: "completed", final_text: "done", usage: null },
      ],
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      await writeFile(
        join(app.paths.workspace, ".git"),
        "gitdir: /nonexistent\n",
        "utf8",
      );

      const task = await submitAndWait(app);
      expect(task.state).toBe("completed");
      expect(task.diff_stat).toBeNull();
      expect(task.commits).toBeNull();
      expect((task.hints as { git?: string } | null)?.git).toEqual(
        expect.any(String),
      );
    } finally {
      await app.close();
    }
  });

  it("captureHead 失敗（Turn 開始前）：completed、hints.git 非空、不呼叫 console.error", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error");
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess-1" },
        { type: "completed", final_text: "done", usage: null },
      ],
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      // 沒有 initGitWorkspace：workspace 不是 git repo，captureHead 在 Turn
      // 開始前就會失敗，這裡驗證失敗不會呼叫 console.error（也不會阻擋 Turn）。
      const task = await submitAndWait(app);
      expect(task.state).toBe("completed");
      expect((task.hints as { git?: string } | null)?.git).toEqual(
        expect.any(String),
      );
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
      await app.close();
    }
  });

  it("driver failed：不跑摘要，diff_stat 為 null 且沒有 hints.git", async () => {
    const driver = scriptedDriver({
      events: [{ type: "failed", error: "boom" }],
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      await initGitWorkspace(app.paths.workspace);

      const task = await submitAndWait(app);
      expect(task.state).toBe("failed");
      expect(task.diff_stat).toBeNull();
      expect((task.hints as { git?: string } | null)?.git).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
