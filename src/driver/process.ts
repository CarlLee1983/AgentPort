import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** 子程序 stderr 只保留尾端這麼多位元組，供錯誤訊息使用。 */
const STDERR_TAIL_BYTES = 64 * 1024;

/** `kill()` 送 SIGTERM 後等多久還沒 `close` 才補 SIGKILL（票 10 預設值）。 */
export const KILL_GRACE_MS = 5000;

export interface SpawnLinesInput {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /**
   * `kill()` 的 SIGTERM → SIGKILL 寬限時間；僅供測試覆寫，正式路徑（`turn.ts`）
   * 一律用預設的 `KILL_GRACE_MS`。
   */
  killGraceMs?: number;
}

export interface LineProcess {
  /** stdout 逐行（不含換行）。子程序結束或被殺後結束。 */
  lines: AsyncIterable<string>;
  /** 子程序結束時 resolve；spawn 失敗（ENOENT 等）時 reject。 */
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** 目前為止的 stderr 尾端。 */
  stderr(): string;
  /**
   * 對整個 process group 送 SIGTERM，`killGraceMs` 後若還沒 `close` 補送
   * SIGKILL。重複呼叫無副作用。
   */
  kill(): void;
}

/**
 * 以 `stdio: ['ignore', 'pipe', 'pipe']` 啟動子程序並逐行讀 stdout。
 * stdin 一定 ignore：Codex 在 stdin 非 TTY 時會讀到 EOF 才開始（票 02 research）。
 * `detached: true` 讓子程序自成一個 process group：CLI 常會再開子程序（如
 * shell 工具呼叫），`kill()` 需要連同這些孫程序一起終止，只殺直接子程序殺不乾淨。
 */
export function spawnLines(input: SpawnLinesInput): LineProcess {
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
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

  let killTimer: NodeJS.Timeout | undefined;
  // `closed` 一旦是 true，這個 pid 就可能已經被 OS 回收給完全不相關的程序：
  // kill() 之後不能再對它送任何信號（見下面 kill() 的 guard）。
  let closed = false;
  child.once("close", () => {
    closed = true;
    clearTimeout(killTimer);
  });

  /**
   * 對 process group（負的 pid）送信號；子程序已經不在了就吞掉 ESRCH。其他
   * 錯誤只記錄不 throw：這個函式也會從 `killGraceMs` 逾時的 timer callback
   * 呼叫，那裡拋例外只會變成 unhandled exception，不會有人接住。
   */
  function signalGroup(signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (pid === undefined) {
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
      console.error(
        `[spawnLines] 送 ${signal} 到 process group ${String(-pid)} 失敗：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

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
      if (closed) {
        // 子程序已經結束（pid 可能已被 OS 回收給別的程序）：不能再送信號。
        return;
      }
      if (killTimer !== undefined) {
        // 已經呼叫過 kill()：SIGTERM 送過了、寬限計時器也在跑，重複呼叫不做事。
        return;
      }
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => {
        signalGroup("SIGKILL");
      }, input.killGraceMs ?? KILL_GRACE_MS);
      killTimer.unref();
    },
  };
}
