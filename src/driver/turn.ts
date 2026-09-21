import { spawnLines } from "./process.js";
import type { DriverEvent, Turn } from "./types.js";

export interface TurnParser {
  /** 餵一行原始 stdout；回傳這一行對映出的事件（可能為空）。 */
  feed(line: string): DriverEvent[];
}

export interface RunTurnInput {
  /** runtime 名稱，用在「結束但無終態事件」的定型錯誤訊息（如 `claude exited with code 1`）。 */
  name: string;
  command: string;
  args: string[];
  workspace: string;
  env: NodeJS.ProcessEnv;
  parser: TurnParser;
  /** 每收到一行原始 CLI 輸出就呼叫一次，供呼叫端寫進原始 JSONL log。 */
  onRawLine?: (line: string) => void;
  /**
   * 從 stderr 尾端判斷是不是「session/thread 找不到」。只有 Codex 用得到：
   * resume 不存在的 thread id 時完全沒有 JSONL 輸出，只能看 stderr；
   * Claude 的同類失敗會反映在 `result` 事件裡，由各自的 parser 處理。
   */
  classifyStderr?: (stderrTail: string) => "session_unresumable" | undefined;
}

function spawnFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Claude、Codex 兩支 Driver 共用的子程序執行迴圈：spawn、逐行餵給 parser、
 * 子程序結束但沒出現過終態事件（`completed` / `failed`）時組出定型的 `failed`、
 * spawn 失敗（如 ENOENT）也回 `failed`、`kill()` 轉呼叫 `LineProcess.kill`。
 *
 * stderr 尾端不會出現在 caller 看到的 `error` 文字裡（那只留一句定型訊息），改由
 * `onRawLine` 以 `{"type":"stderr","text":...}` 寫進原始 log，供除錯用（見 04/05
 * 票 code review）。
 */
export function runTurn(input: RunTurnInput): Turn {
  const child = spawnLines({
    command: input.command,
    args: input.args,
    cwd: input.workspace,
    env: input.env,
  });

  async function* events(): AsyncIterable<DriverEvent> {
    let sawTerminal = false;
    try {
      for await (const line of child.lines) {
        input.onRawLine?.(line);
        for (const event of input.parser.feed(line)) {
          if (event.type === "completed" || event.type === "failed") {
            sawTerminal = true;
          }
          yield event;
        }
      }
    } catch (error) {
      yield { type: "failed", error: spawnFailureMessage(error) };
      return;
    }
    if (!sawTerminal) {
      const { code } = await child.exit;
      const stderrTail = child.stderr();
      if (stderrTail.trim().length > 0) {
        input.onRawLine?.(
          JSON.stringify({ type: "stderr", text: stderrTail.trim() }),
        );
      }
      const sessionUnresumable = input.classifyStderr?.(stderrTail);
      yield sessionUnresumable
        ? {
            type: "failed",
            error: "session not found",
            code: sessionUnresumable,
          }
        : {
            type: "failed",
            error: `${input.name} exited with code ${String(code)}`,
          };
    }
  }

  return {
    events: events(),
    kill: () => {
      child.kill();
    },
  };
}
