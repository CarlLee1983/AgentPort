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
  /**
   * 送出第 `holdAfter` 個事件後卡住（不再送下一個），一直等到 `kill()` 被呼叫
   * 才繼續（此時一定會走到 `isKilled()` 判斷而中止迭代）。跟 `delayMs` 不同：
   * 這是無限期卡住，不是固定時間，讓測試不用猜時間點就能保證「事件已送達、
   * Turn 仍在跑」這個狀態，靠 `pulled(n)` 確認送達、`kill()` 才會讓它繼續。
   */
  holdAfter?: number;
  throwAfter?: number;
  onStart?: (input: TurnInput) => void | Promise<void>;
  /**
   * `kill()` 之後（events 迭代提早結束）再多送一個 `failed` 事件，模擬
   * 「被殺之後 driver 自己又回報了一次失敗」；用來驗證取消／逾時贏過終態事件。
   */
  failAfterKill?: boolean;
}

/** 等 `ms` 毫秒或 `killed` 先發生（先到者贏），供 `kill()` 能立刻中斷等待中的延遲。 */
function delay(ms: number, killed: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void killed.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * 依腳本吐事件的假 Driver：`events` 依序送出，`delayMs` 讓每個事件延遲一段時間，
 * `throwAfter` 送出該數量事件後改丟例外（模擬 Driver 迭代中斷）。`rawLines`（如果
 * 有）在事件開始送出前，依序呼叫呼叫端傳入的 `hooks.onRawLine`，模擬真 Driver
 * 把原始 CLI 行寫進 JSONL 的行為。`start`/`resume` 收到的 `TurnInput` 會記錄在
 * `received` 供測試檢查；`pulled(n)` 等到第 n 個事件被送出、`killCount` 記錄
 * `kill()` 被呼叫過幾次，供測試用確定性的方式（而不是猜時間點）等到「事件已
 * 送達」再動作。
 */
export function scriptedDriver(script: DriverScript): RuntimeDriver & {
  received: TurnInput[];
  pulled(n: number): Promise<void>;
  readonly killCount: number;
} {
  return sequencedDriver([script]);
}

/**
 * 像 `scriptedDriver`，但依序消耗多份 `DriverScript`：第 N 次呼叫（`start`
 * 或 `resume` 皆計入同一個計數器）用 `scripts[N]`，超過陣列長度時沿用最後一份。
 * 用來模擬「前一個 Task 用某個腳本、follow-up 的 Task 用另一個腳本」，例如第一輪
 * 正常 `completed`、第二輪（resume）回 `failed{session_unresumable}`。
 *
 * `pulled(n)` 跟 `killCount` 都放在 driver 這層（不是個別 Turn 裡）：測試往往
 * 在 `submit_task` 的 tool 呼叫回來後就立刻呼叫 `pulled(n)`，這時 scheduler
 * 那條 FIFO chain 可能還沒真的排到 `driver.start()`——如果等待狀態綁在某個
 * Turn 物件上，Turn 還沒建立時 `pulled()` 就無處可等，只能兩害相權：要嘛提早
 * 判定「已送達」（錯），要嘛掛在一個永遠不會被呼叫的 turn-local 函式上（等到
 * 天荒地老）。放在 driver 這層就沒有這個問題：等待者先掛著，不管 Turn 什麼
 * 時候建立、什麼時候真的送出第 n 個事件，`markPulled` 都能找到它並喚醒。
 */
export function sequencedDriver(scripts: DriverScript[]): RuntimeDriver & {
  received: TurnInput[];
  pulled(n: number): Promise<void>;
  readonly killCount: number;
} {
  const received: TurnInput[] = [];
  let callCount = 0;
  let killCount = 0;

  let pulledCount = 0;
  const pulledWaiters: { n: number; resolve: () => void }[] = [];
  function markPulled(n: number): void {
    pulledCount = n;
    for (let idx = pulledWaiters.length - 1; idx >= 0; idx -= 1) {
      const waiter = pulledWaiters[idx];
      if (waiter && pulledCount >= waiter.n) {
        waiter.resolve();
        pulledWaiters.splice(idx, 1);
      }
    }
  }
  function pulled(n: number): Promise<void> {
    if (pulledCount >= n) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      pulledWaiters.push({ n, resolve });
    });
  }

  function makeTurn(input: TurnInput, hooks?: TurnHooks): Turn {
    received.push(input);
    const script = scripts[
      Math.min(callCount, scripts.length - 1)
    ] as DriverScript;
    callCount += 1;
    let killed = false;
    // 包一層函式呼叫再讀：`await delay(...)` 前後各檢查一次同一個 `killed`，TS
    // 的窄化會誤以為兩次檢查之間（即使中間橫跨了 await、`kill()` 可能已經把
    // 值改掉）沒有任何賦值，把型別窄化成恆為 `false`。
    const isKilled = (): boolean => killed;
    let resolveKilled!: () => void;
    const killedPromise = new Promise<void>((resolve) => {
      resolveKilled = resolve;
    });

    async function* events(): AsyncIterable<DriverEvent> {
      for (const line of script.rawLines ?? []) {
        hooks?.onRawLine?.(line);
      }
      if (script.onStart) {
        await script.onStart(input);
      }
      for (let i = 0; i < script.events.length; i += 1) {
        if (isKilled()) {
          break;
        }
        if (script.delayMs) {
          await delay(script.delayMs, killedPromise);
        }
        if (isKilled()) {
          break;
        }
        if (script.throwAfter !== undefined && i >= script.throwAfter) {
          throw new Error("scripted driver failure");
        }
        yield script.events[i] as DriverEvent;
        markPulled(i + 1);
        if (script.holdAfter === i + 1) {
          // 卡住直到 kill()（或呼叫端的逾時計時器呼叫 kill()）為止，不用猜時間。
          await killedPromise;
        }
      }
      if (isKilled() && script.failAfterKill) {
        yield { type: "failed", error: "killed" };
      }
    }

    return {
      events: events(),
      kill() {
        killed = true;
        killCount += 1;
        resolveKilled();
      },
    };
  }

  return {
    received,
    pulled,
    get killCount() {
      return killCount;
    },
    start(input, hooks) {
      return makeTurn(input, hooks);
    },
    resume(input, hooks) {
      return makeTurn(input, hooks);
    },
  };
}
