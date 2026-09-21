import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

export interface RawLog {
  path: string;
  /** 寫入一行原始文字（不含換行，這裡補上）；不對內容做任何映射或解析。 */
  writeLine(line: string): void;
  close(): void;
}

/**
 * 在 `logDir` 下開一份 `<taskId>.jsonl`，每行是 Runtime CLI 的原始輸出；
 * `logDir` 不存在時建立。寫的是原始行而不是 AgentPort 映射後的事件，
 * 出問題時才看得到 runtime 到底吐了什麼（見 specs/agentport-v2.md）。
 */
export function openRawLog(logDir: string, taskId: string): RawLog {
  mkdirSync(logDir, { recursive: true });
  const path = join(logDir, `${taskId}.jsonl`);
  const fd = openSync(path, "a");
  return {
    path,
    writeLine(line) {
      writeSync(fd, `${line}\n`);
    },
    close() {
      closeSync(fd);
    },
  };
}
