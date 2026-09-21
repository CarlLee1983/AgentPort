import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** git 指令逾時與輸出上限；抽成具名常數，兩個都在 `runGit` 統一套用。 */
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** 空樹的固定 sha，git 內建物件，任何 repo 都能拿來當「起點什麼都沒有」的比較基準。 */
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** 每個 git 呼叫都帶這個全域選項，讓非 ASCII 檔名原樣輸出而不是被跳脫成 `\NNN` 八進位。 */
const GIT_GLOBAL_ARGS = ["-c", "core.quotePath=false"];

export interface GitCommit {
  sha: string;
  subject: string;
}

export interface GitSummary {
  diff_stat: string;
  commits: GitCommit[];
}

export type GitSummaryResult =
  { ok: true; summary: GitSummary } | { ok: false; reason: string };

export type CaptureHeadResult =
  { ok: true; head: string | null } | { ok: false; reason: string };

type GitRunResult =
  { ok: true; stdout: string } | { ok: false; reason: string; stderr: string };

/** stderr 常常是多行說明，`hints.git` / 分類判斷只取第一行當摘要理由。 */
function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

function stderrFromError(error: unknown): string {
  const stderr = (error as { stderr?: string } | null)?.stderr;
  if (stderr && stderr.trim().length > 0) {
    return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

async function runGit(
  args: string[],
  workspace: string,
): Promise<GitRunResult> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [...GIT_GLOBAL_ARGS, ...args],
      {
        cwd: workspace,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
      },
    );
    return { ok: true, stdout };
  } catch (error) {
    const stderr = stderrFromError(error);
    return { ok: false, reason: firstLine(stderr), stderr };
  }
}

/** `rev-parse HEAD` 在空 repo（尚無 commit）時失敗的固定錯誤訊息，其他失敗都是真的錯。 */
function isUnbornHeadError(stderr: string): boolean {
  return /unknown revision|ambiguous argument 'HEAD'/.test(stderr);
}

/** Turn 開始前記下 HEAD；`head: null` 專指 repo 尚無 commit（unborn），其他失敗回 `ok:false`。 */
export async function captureHead(
  workspace: string,
): Promise<CaptureHeadResult> {
  const insideCheck = await runGit(
    ["rev-parse", "--is-inside-work-tree"],
    workspace,
  );
  if (!insideCheck.ok) {
    return { ok: false, reason: insideCheck.reason };
  }
  const headResult = await runGit(["rev-parse", "HEAD"], workspace);
  if (!headResult.ok) {
    if (isUnbornHeadError(headResult.stderr)) {
      return { ok: true, head: null };
    }
    return { ok: false, reason: headResult.reason };
  }
  return { ok: true, head: headResult.stdout.trim() };
}

function parseUntracked(statusOutput: string): string[] {
  return statusOutput
    .split("\n")
    .filter((line) => line.startsWith("??"))
    .map((line) => line.slice(2).trim())
    .filter((name) => name.length > 0);
}

function parseCommits(logOutput: string): GitCommit[] {
  return logOutput
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [sha, ...rest] = line.split("\t");
      return { sha: sha ?? "", subject: rest.join("\t") };
    });
}

/**
 * Turn 結束後產生 `diff_stat`（含 untracked）與 `startHead` 到 HEAD 的 commit 清單。
 * `startHead: null` 代表 Turn 開始時 repo 還沒有任何 commit，改跟空樹（`EMPTY_TREE_SHA`）
 * 比對，這樣 Turn 期間新增並 commit 的檔案才會出現在 `diff_stat`。`workspace` 可以是
 * repo 的子目錄：`diff_stat` 用 `--relative -- .` 限縮並相對化到子樹，`commits` 不受
 * 子目錄限制，`<start>..HEAD` 一律全列。
 */
export async function summarizeTurn(
  workspace: string,
  startHead: string | null,
): Promise<GitSummaryResult> {
  const insideCheck = await runGit(
    ["rev-parse", "--is-inside-work-tree"],
    workspace,
  );
  if (!insideCheck.ok) {
    return { ok: false, reason: insideCheck.reason };
  }

  const base = startHead ?? EMPTY_TREE_SHA;
  const diffResult = await runGit(
    ["diff", "--stat", "--relative", base, "--", "."],
    workspace,
  );
  if (!diffResult.ok) {
    return { ok: false, reason: diffResult.reason };
  }

  const statusResult = await runGit(
    ["status", "--porcelain", "--untracked-files=all", "--", "."],
    workspace,
  );
  if (!statusResult.ok) {
    return { ok: false, reason: statusResult.reason };
  }
  const untracked = parseUntracked(statusResult.stdout);
  const diffStat =
    untracked.length > 0
      ? `${diffResult.stdout} untracked: ${untracked.join(", ")}`
      : diffResult.stdout;

  const logArgs =
    startHead !== null
      ? ["log", "--format=%H%x09%s", "--reverse", `${startHead}..HEAD`]
      : ["log", "--format=%H%x09%s", "--reverse"];
  const logResult = await runGit(logArgs, workspace);
  if (!logResult.ok) {
    if (startHead === null) {
      // HEAD 尚不存在（空 repo 從未有過 commit）時 `git log` 會失敗，視為空陣列。
      return { ok: true, summary: { diff_stat: diffStat, commits: [] } };
    }
    return { ok: false, reason: logResult.reason };
  }

  return {
    ok: true,
    summary: { diff_stat: diffStat, commits: parseCommits(logResult.stdout) },
  };
}
