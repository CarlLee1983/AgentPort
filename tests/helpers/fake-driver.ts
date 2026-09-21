import type {
  DriverEvent,
  RuntimeDriver,
  Turn,
  TurnHooks,
  TurnInput,
} from "../../src/driver/types.js";

export interface DriverScript {
  events: DriverEvent[];
  /** 假的原始 CLI 行：`start`/`resume` 一開始就依序餵給 `hooks.onRawLine`。 */
  rawLines?: string[];
  delayMs?: number;
  throwAfter?: number;
  onStart?: (input: TurnInput) => void | Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 依腳本吐事件的假 Driver：`events` 依序送出，`delayMs` 讓每個事件延遲一段時間，
 * `throwAfter` 送出該數量事件後改丟例外（模擬 Driver 迭代中斷）。`rawLines`（如果
 * 有）在事件開始送出前，依序呼叫呼叫端傳入的 `hooks.onRawLine`，模擬真 Driver
 * 把原始 CLI 行寫進 JSONL 的行為。`start`/`resume` 收到的 `TurnInput` 會記錄在
 * `received` 供測試檢查。
 */
export function scriptedDriver(script: DriverScript): RuntimeDriver & {
  received: TurnInput[];
} {
  return sequencedDriver([script]);
}

/**
 * 像 `scriptedDriver`，但依序消耗多份 `DriverScript`：第 N 次呼叫（`start`
 * 或 `resume` 皆計入同一個計數器）用 `scripts[N]`，超過陣列長度時沿用最後一份。
 * 用來模擬「前一個 Task 用某個腳本、follow-up 的 Task 用另一個腳本」，例如第一輪
 * 正常 `completed`、第二輪（resume）回 `failed{session_unresumable}`。
 */
export function sequencedDriver(scripts: DriverScript[]): RuntimeDriver & {
  received: TurnInput[];
} {
  const received: TurnInput[] = [];
  let callCount = 0;

  function makeTurn(input: TurnInput, hooks?: TurnHooks): Turn {
    received.push(input);
    const script = scripts[
      Math.min(callCount, scripts.length - 1)
    ] as DriverScript;
    callCount += 1;
    let killed = false;

    async function* events(): AsyncIterable<DriverEvent> {
      for (const line of script.rawLines ?? []) {
        hooks?.onRawLine?.(line);
      }
      if (script.onStart) {
        await script.onStart(input);
      }
      for (let i = 0; i < script.events.length; i += 1) {
        if (killed) {
          return;
        }
        if (script.delayMs) {
          await delay(script.delayMs);
        }
        if (script.throwAfter !== undefined && i >= script.throwAfter) {
          throw new Error("scripted driver failure");
        }
        yield script.events[i] as DriverEvent;
      }
    }

    return {
      events: events(),
      kill() {
        killed = true;
      },
    };
  }

  return {
    received,
    start(input, hooks) {
      return makeTurn(input, hooks);
    },
    resume(input, hooks) {
      return makeTurn(input, hooks);
    },
  };
}
