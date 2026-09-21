import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** 子程序 stderr 只保留尾端這麼多位元組，供錯誤訊息使用。 */
const STDERR_TAIL_BYTES = 64 * 1024;

export interface SpawnLinesInput {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface LineProcess {
  /** stdout 逐行（不含換行）。子程序結束或被殺後結束。 */
  lines: AsyncIterable<string>;
  /** 子程序結束時 resolve；spawn 失敗（ENOENT 等）時 reject。 */
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** 目前為止的 stderr 尾端。 */
  stderr(): string;
  /** 送 SIGTERM。取消保證由票 10 定義。 */
  kill(): void;
}

/**
 * 以 `stdio: ['ignore', 'pipe', 'pipe']` 啟動子程序並逐行讀 stdout。
 * stdin 一定 ignore：Codex 在 stdin 非 TTY 時會讀到 EOF 才開始（票 02 research）。
 */
export function spawnLines(input: SpawnLinesInput): LineProcess {
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  });

  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
  // 沒人 await exit 時不要變成 unhandled rejection；錯誤會在 lines 迭代時再浮現。
  exit.catch(() => undefined);

  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lines: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      for await (const line of reader) {
        yield line;
      }
      await exit;
    },
  };

  return {
    lines,
    exit,
    stderr: () => stderrTail,
    kill: () => {
      child.kill("SIGTERM");
    },
  };
}
