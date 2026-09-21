import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { captureHead, summarizeTurn } from "../../src/git/summary.js";
import { cleanupTempDirs, makeTempDir } from "../config/helpers.js";
import { gitCommitAll, initGitWorkspace } from "../helpers/git.js";

afterEach(cleanupTempDirs);

describe("captureHead / summarizeTurn", () => {
  it("unborn repo：新增並 commit 後 diff_stat 含檔名、commits 一筆", async () => {
    const dir = await makeTempDir();
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q"], { cwd: dir });

    const head = await captureHead(dir);
    expect(head).toEqual({ ok: true, head: null });

    await writeFile(join(dir, "a.txt"), "hello\n", "utf8");
    gitCommitAll(dir, "add a.txt");

    const summary = await summarizeTurn(dir, head.ok ? head.head : "bogus");
    expect(summary.ok).toBe(true);
    if (summary.ok) {
      expect(summary.summary.diff_stat).toContain("a.txt");
      expect(summary.summary.commits).toEqual([
        { sha: expect.any(String) as string, subject: "add a.txt" },
      ]);
    }
  });

  it("子目錄 workspace 只列子樹改動且路徑相對 workspace，commits 仍列出", async () => {
    const dir = await makeTempDir();
    await initGitWorkspace(dir);
    await mkdir(join(dir, "sub"), { recursive: true });
    await mkdir(join(dir, "outside"), { recursive: true });

    const head = await captureHead(join(dir, "sub"));
    expect(head).toEqual({ ok: true, head: expect.any(String) as string });

    await writeFile(join(dir, "outside", "unrelated.txt"), "x\n", "utf8");
    gitCommitAll(dir, "add outside file");
    await writeFile(join(dir, "sub", "in-scope.txt"), "y\n", "utf8");
    gitCommitAll(dir, "add in-scope file");

    const summary = await summarizeTurn(
      join(dir, "sub"),
      head.ok ? head.head : null,
    );
    expect(summary.ok).toBe(true);
    if (summary.ok) {
      expect(summary.summary.diff_stat).toContain("in-scope.txt");
      expect(summary.summary.diff_stat).not.toContain("unrelated.txt");
      expect(summary.summary.commits.map((c) => c.subject)).toEqual([
        "add outside file",
        "add in-scope file",
      ]);
    }
  });

  it("非 ASCII 檔名原樣輸出", async () => {
    const dir = await makeTempDir();
    await initGitWorkspace(dir);
    const head = await captureHead(dir);
    expect(head.ok).toBe(true);

    await writeFile(join(dir, "測試檔案.txt"), "hi\n", "utf8");

    const summary = await summarizeTurn(dir, head.ok ? head.head : null);
    expect(summary.ok).toBe(true);
    if (summary.ok) {
      expect(summary.summary.diff_stat).toContain("測試檔案.txt");
    }
  });

  it(".git 指向不存在目錄 → captureHead 回 ok:false", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".git"), "gitdir: /nonexistent\n", "utf8");

    const head = await captureHead(dir);
    expect(head.ok).toBe(false);
  });

  it("subject 含 tab 仍可正確解析", async () => {
    const dir = await makeTempDir();
    await initGitWorkspace(dir);
    await writeFile(join(dir, "b.txt"), "z\n", "utf8");
    gitCommitAll(dir, "subject\twith\ttabs");

    // 用一個舊的起點：initGitWorkspace 的 initial commit sha 當起點。
    const { execFileSync } = await import("node:child_process");
    const initialSha = execFileSync(
      "git",
      ["rev-list", "--max-parents=0", "HEAD"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    ).trim();

    const summary = await summarizeTurn(dir, initialSha);
    expect(summary.ok).toBe(true);
    if (summary.ok) {
      expect(summary.summary.commits).toEqual([
        { sha: expect.any(String) as string, subject: "subject\twith\ttabs" },
      ]);
    }
  });
});
