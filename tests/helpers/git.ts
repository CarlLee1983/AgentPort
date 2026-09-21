import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 讓測試裡跑的 git 指令不依賴機器上的全域設定。 */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "AgentPort Test",
  GIT_AUTHOR_EMAIL: "test@agentport.local",
  GIT_COMMITTER_NAME: "AgentPort Test",
  GIT_COMMITTER_EMAIL: "test@agentport.local",
};

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "pipe" });
}

/**
 * 把一個既存目錄變成一個真的 git repo：`git init`，寫一個檔案並建立 initial
 * commit，回傳該檔案的絕對路徑供測試之後修改。
 */
export async function initGitWorkspace(dir: string): Promise<string> {
  git(["init", "-q"], dir);
  const filePath = join(dir, "existing.txt");
  await writeFile(filePath, "initial\n", "utf8");
  git(["add", "existing.txt"], dir);
  git(["commit", "-q", "-m", "initial commit"], dir);
  return filePath;
}

export function gitCommitAll(dir: string, message: string): void {
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", message], dir);
}
