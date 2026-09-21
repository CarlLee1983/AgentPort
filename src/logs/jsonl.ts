import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

export interface RawLog {
  path: string;
  write(event: unknown): void;
  close(): void;
}

/** 在 `logDir` 下開一份 `<taskId>.jsonl`，每個事件一行 JSON；`logDir` 不存在時建立。 */
export function openRawLog(logDir: string, taskId: string): RawLog {
  mkdirSync(logDir, { recursive: true });
  const path = join(logDir, `${taskId}.jsonl`);
  const fd = openSync(path, "a");
  return {
    path,
    write(event) {
      writeSync(fd, `${JSON.stringify(event)}\n`);
    },
    close() {
      closeSync(fd);
    },
  };
}
