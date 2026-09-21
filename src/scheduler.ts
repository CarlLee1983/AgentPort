import type { Config } from "./config/schema.js";
import type { DriverEvent, DriverRegistry, Turn } from "./driver/types.js";
import {
  captureHead,
  summarizeTurn,
  type CaptureHeadResult,
} from "./git/summary.js";
import { openRawLog, type RawLog } from "./logs/jsonl.js";
import type { TaskRecord, TaskStore } from "./store/sqlite.js";
import type { TaskNotifier } from "./task/notifier.js";
import {
  isTerminalState,
  type Hints,
  type TaskErrorCode,
} from "./task/schema.js";

export interface SchedulerDeps {
  store: TaskStore;
  drivers: DriverRegistry;
  config: Config;
  notifier: TaskNotifier;
  /** 僅供測試：覆寫 `config.server.turn_timeout_seconds` 換算出的毫秒數。 */
  turnTimeoutMs?: number;
}

export type CancelOutcome =
  "not_found" | "invalid_state" | "cancelled" | "cancelling";

export interface Scheduler {
  enqueue(taskId: string): void;
  /**
   * 對排隊中或執行中的 Task 送出取消：queued 立刻生效回 `cancelled`；running
   * 送出 kill 後回 `cancelling`（真正變 cancelled 是非同步的，呼叫端可用
   * `get_task` / `cancel_task` 的等待邏輯觀察）；終態 Task 回 `invalid_state`；
   * 不存在回 `not_found`。running 但這個 process 沒有對應 Turn 可殺（例如前次
   * 服務程序意外中止殘留的 running Task）直接收斂成 `cancelled`，不會回
   * `cancelling` 讓呼叫端白等。
   */
  cancel(taskId: string): CancelOutcome;
  /**
   * 關服務前呼叫：把所有還在跑的 Turn 都 kill 掉，避免留下孤兒子程序。這裡
   * 不寫任何 store（呼叫當下往往 store 也快關了）；DB 裡這些 Task 會留在
   * `running`，交給下次啟動時的重啟掃描處理（票 11）。
   */
  shutdown(): void;
}

type StopReason = "cancelled" | "timeout";

/** 一個正在跑的 Task 的可變狀態：`turn` 建立前 cancel() 只能先記下 stopReason。 */
interface ActiveTask {
  stopReason?: StopReason;
  turn?: Turn;
  /** 這個 Task 實際生效的逾時毫秒數（`turnTimeoutMs` 覆寫或 config 換算）。 */
  timeoutMs: number;
}

/**
 * 讀 `entry.stopReason` 目前的值。特意包一層函式呼叫：`runActiveTurn` 裡在
 * `await` 前後各檢查一次同一個 `activeTask`，TS 的窄化會誤以為兩次檢查之間
 * （即使中間橫跨了 `await`、`cancel()` 可能已經從另一次工具呼叫把值改掉）
 * 沒有任何賦值、把型別窄化成恆為 `undefined`；經函式呼叫拿到的型別就是宣告
 * 型別本身，不會被誤窄化。
 */
function readStopReason(entry: ActiveTask): StopReason | undefined {
  return entry.stopReason;
}

interface CompletedOutcome {
  final_text: string;
  usage: Record<string, number> | null;
}

interface FailedOutcome {
  code: TaskErrorCode;
  message: string;
}

interface EventOutcome {
  hints: Hints;
  terminal: boolean;
  completed?: CompletedOutcome;
  failed?: FailedOutcome;
  /** 這個事件是不是剛剛才把 `runtime_session_id` 回填進 context。 */
  filledRuntimeSession?: boolean;
}

interface GitSummaryOutcome {
  diff_stat: string | null;
  commits: TaskRecord["commits"];
  /** git 摘要失敗（或 captureHead 早就失敗）的原因；成功時不設。 */
  gitHint?: string;
}

/** 收斂成取消／逾時時需要的三樣東西，包成一個物件避免 `finishCancelled` 參數過長。 */
interface TurnResult {
  hints: Hints;
  messages: string[];
  completed: CompletedOutcome | undefined;
}

/**
 * 每 agent 一條 FIFO promise chain：同一 agent 的 Task 依序執行，不同 agent
 * 並行，無上限。`enqueue` 在呼叫當下讀 task 決定要接到哪條 chain 後面，`runTask`
 * 內任何例外都在自己的 try/catch 收斂成 `markFailed`，`.catch` 只是防止鏈斷掉
 * 的最後防線。
 *
 * `active` 記錄目前正在跑的 Task：`runTask` 一進 running 狀態就註冊
 * （`finally` 移除），`cancel()` 靠它找到對應的 `Turn` 送 kill、或在 `Turn`
 * 還沒建立時先記下 `stopReason`，等 `runTask` 自己發現後收斂成取消。
 */
export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { store, drivers, config, notifier } = deps;
  const chains = new Map<string, Promise<void>>();
  const active = new Map<string, ActiveTask>();

  function enqueue(taskId: string): void {
    const task = store.getTask(taskId);
    if (!task) {
      return;
    }
    const agent = task.agent;
    const previous = chains.get(agent) ?? Promise.resolve();
    const next = previous
      .then(() => runTask(taskId))
      .catch((error: unknown) => {
        console.error(
          `[scheduler] task ${taskId} 執行時發生未預期例外：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    chains.set(agent, next);
  }

  function cancel(taskId: string): CancelOutcome {
    const task = store.getTask(taskId);
    if (!task) {
      return "not_found";
    }
    if (isTerminalState(task.state)) {
      return "invalid_state";
    }

    if (task.state === "queued") {
      const didCancel = store.cancelQueued(taskId, {
        code: "cancelled",
        message: "cancelled by caller",
      });
      if (didCancel) {
        notifier.notify(taskId);
        return "cancelled";
      }
      // 跟 worker 取出這個 Task 撞了車：這一瞬間已經變成 running，往下當
      // running 處理。
    }

    const entry = active.get(taskId);
    if (!entry) {
      // 防禦分支：正常情況下走不到這裡。啟動時的重啟掃描（票 11，
      // `createApp` 裡的 `store.interruptRunning()`）已經把上次程序中止時
      // 殘留的 running Task 全部收斂成 failed，加上 single-instance 鎖保證
      // 同一個 db_path 不會有第二個 process，這個 process 看到的 running
      // Task 理論上都在 `active` 裡有對應項目。保留這條分支只是為了在假設
      // 破裂（例如未來繞過 `createApp` 直接操作 store）時仍有安全的收斂
      // 行為，而不是讓呼叫端對著一個永遠沒有 Turn 可以 kill 的 Task 白等
      // `cancelling`。
      markCancelled(taskId, {
        final_text: "",
        usage: null,
        code: "cancelled",
        message: "cancelled by caller",
      });
      return "cancelled";
    }
    if (!entry.stopReason) {
      entry.stopReason = "cancelled";
    }
    entry.turn?.kill();
    return "cancelling";
  }

  function shutdown(): void {
    for (const entry of active.values()) {
      if (!entry.stopReason) {
        entry.stopReason = "cancelled";
      }
      entry.turn?.kill();
    }
  }

  /** store 寫入狀態後立刻通知 notifier，讓 get_task 的 long-poll 可以醒過來。 */
  function markRunning(taskId: string, rawLogPath: string): void {
    store.markRunning(taskId, rawLogPath);
    notifier.notify(taskId);
  }

  function markCompleted(
    taskId: string,
    input: Parameters<TaskStore["markCompleted"]>[1],
  ): void {
    store.markCompleted(taskId, input);
    notifier.notify(taskId);
  }

  function markFailed(
    taskId: string,
    input: Parameters<TaskStore["markFailed"]>[1],
  ): void {
    store.markFailed(taskId, input);
    notifier.notify(taskId);
  }

  function markCancelled(
    taskId: string,
    input: Parameters<TaskStore["markCancelled"]>[1],
  ): void {
    store.markCancelled(taskId, input);
    notifier.notify(taskId);
  }

  async function runTask(taskId: string): Promise<void> {
    let rawLog: RawLog | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    try {
      const task = store.getTask(taskId);
      if (!task) {
        return;
      }
      if (task.state !== "queued") {
        // 排隊期間就被取消了（`store.cancelQueued` 已經寫入終態），不進 worker。
        return;
      }

      const agent = config.agents.find(
        (candidate) => candidate.name === task.agent,
      );
      if (!agent) {
        markFailed(taskId, {
          code: "runtime_failed",
          message: `未知 agent：${task.agent}`,
        });
        return;
      }

      rawLog = openRawLog(config.storage.log_dir, taskId);
      markRunning(taskId, rawLog.path);

      const timeoutMs =
        deps.turnTimeoutMs ?? config.server.turn_timeout_seconds * 1000;
      const activeTask: ActiveTask = { timeoutMs };
      active.set(taskId, activeTask);
      // 逾時計時從 `markRunning` 那一刻開始（涵蓋 captureHead），不是等 Turn
      // 建立才開始算：captureHead 慢（例如 git 呼叫卡住）也該算進逾時預算，
      // 不能讓它偷走實際執行 Turn 的時間卻不算數。
      timeoutTimer = setTimeout(() => {
        if (!activeTask.stopReason) {
          activeTask.stopReason = "timeout";
          activeTask.turn?.kill();
        }
      }, timeoutMs);
      timeoutTimer.unref();

      try {
        await runActiveTurn(task, agent, activeTask, rawLog);
      } finally {
        active.delete(taskId);
      }
    } catch (error) {
      markFailed(taskId, {
        code: "runtime_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeoutTimer);
      rawLog?.close();
    }
  }

  /**
   * `markRunning` 之後的實際執行：跑 Turn、收事件、依「是否被取消／逾時」
   * 決定收斂成 cancelled 還是原本的 completed / failed。抽出來是因為
   * `active`/`try…finally` 的登記要包住這整段，`runTask` 本身留給例外收斂。
   */
  async function runActiveTurn(
    task: TaskRecord,
    agent: Config["agents"][number],
    activeTask: ActiveTask,
    rawLog: RawLog,
  ): Promise<void> {
    // captureHead 失敗不阻擋 Turn：先記下結果，等 completed／cancelled 時再
    // 決定要不要跑 summarizeTurn。
    const headResult = await captureHead(agent.workspace);

    const stopReasonBeforeTurn = readStopReason(activeTask);
    if (stopReasonBeforeTurn) {
      // 取消／逾時發生在 captureHead 這段 await 期間，Turn 還沒建立：不啟動
      // driver，直接收斂成取消（沒有收到任何 message，final_text 是空字串）。
      await finishCancelled(
        task.task_id,
        agent.workspace,
        headResult,
        { hints: {}, messages: [], completed: undefined },
        stopReasonBeforeTurn,
        activeTask,
      );
      return;
    }

    const driver = drivers[agent.runtime];
    const context = store.getContext(task.context_id);
    const turnInput = {
      workspace: agent.workspace,
      prompt: task.prompt,
      policy: agent.policy,
      extra_args: agent.extra_args ?? [],
    };
    const hooks = {
      onRawLine: (line: string) => {
        rawLog.writeLine(line);
      },
    };
    const turn =
      context?.runtime_session_id !== null &&
      context?.runtime_session_id !== undefined
        ? driver.resume(
            { ...turnInput, runtime_session_id: context.runtime_session_id },
            hooks,
          )
        : driver.start(turnInput, hooks);

    // 從上面 `if (stopReasonBeforeTurn)` 的 early return 到這裡都是同步程式碼、
    // 中間沒有 await，`cancel()` 不可能插進來，故不需要在這裡再補一次 kill()。
    activeTask.turn = turn;

    // 第一個 Task 才回填 runtime_session_id（spec）：resume 的 Task 一開始
    // context 就已經有值，之後收到的 `started` 事件（不管是同一個 Task 內
    // 重複送，或這個 run 本身就是 resume）都不該覆寫掉原本的值。
    let hasRuntimeSession =
      context?.runtime_session_id !== null &&
      context?.runtime_session_id !== undefined;

    let hints: Hints = {};
    let terminal = false;
    let completed: CompletedOutcome | undefined;
    let failed: FailedOutcome | undefined;
    const messages: string[] = [];
    for await (const event of turn.events) {
      if (terminal) {
        // 已經收到終態事件（completed / failed），忽略之後送來的事件，不覆寫結果。
        continue;
      }
      if (event.type === "message") {
        messages.push(event.text);
      }
      const outcome = handleEvent(task, hints, event, hasRuntimeSession);
      hints = outcome.hints;
      terminal = outcome.terminal;
      if (outcome.completed) {
        completed = outcome.completed;
      }
      if (outcome.failed) {
        failed = outcome.failed;
      }
      if (outcome.filledRuntimeSession) {
        hasRuntimeSession = true;
      }
    }

    const stopReasonAfterLoop = readStopReason(activeTask);
    if (stopReasonAfterLoop) {
      // 取消／逾時贏過任何終態事件：即使 driver 在被 kill 後又送了 completed
      // 或 failed，Task 一律收斂成 cancelled/timeout。
      await finishCancelled(
        task.task_id,
        agent.workspace,
        headResult,
        { hints, messages, completed },
        stopReasonAfterLoop,
        activeTask,
      );
    } else if (completed) {
      await finishCompleted(
        task.task_id,
        agent.workspace,
        headResult,
        hints,
        completed,
        activeTask,
      );
    } else if (failed) {
      markFailed(task.task_id, {
        code: failed.code,
        message: failed.message,
        hints: hintsOrUndefined(hints),
      });
    } else if (!terminal) {
      markFailed(task.task_id, {
        code: "runtime_failed",
        message: "driver ended without terminal event",
        hints: hintsOrUndefined(hints),
      });
    }
  }

  function handleEvent(
    task: TaskRecord,
    hints: Hints,
    event: DriverEvent,
    hasRuntimeSession: boolean,
  ): EventOutcome {
    switch (event.type) {
      case "started":
        if (hasRuntimeSession) {
          return { hints, terminal: false };
        }
        store.setRuntimeSession(task.context_id, event.runtime_session_id);
        return { hints, terminal: false, filledRuntimeSession: true };
      case "permission_denied":
        return {
          hints: {
            ...hints,
            permission_denied: [
              ...(hints.permission_denied ?? []),
              { tool: event.tool, input: event.input },
            ],
          },
          terminal: false,
        };
      case "completed":
        // git 摘要要等收完事件後才跑（見 finishCompleted），這裡只記下 completed 的資料。
        return {
          hints,
          terminal: true,
          completed: { final_text: event.final_text, usage: event.usage },
        };
      case "failed":
        // 是否真的收斂成 failed 留給呼叫端：取消／逾時贏過這個結果。
        return {
          hints,
          terminal: true,
          failed: {
            code: event.code ?? "runtime_failed",
            message: event.error,
          },
        };
      case "message":
      case "activity":
        // 這張票不記錄中間文字與活動摘要進 hints，final_text（非取消時）只來自
        // completed 事件；`message` 的文字另外在呼叫端收集，供取消／逾時時當
        // final_text 的備案。
        return { hints, terminal: false };
    }
  }

  /**
   * `captureHead` 已經失敗就不用再跑 `summarizeTurn`（結果只會是同一種錯），
   * 直接把原因當 `gitHint`；成功時才呼叫 `summarizeTurn`，失敗（非 git 目錄、
   * git 指令出錯）一樣只回 `gitHint`，兩個結果的形狀給 completed／cancelled
   * 共用。
   */
  async function resolveGitSummary(
    workspace: string,
    headResult: CaptureHeadResult,
  ): Promise<GitSummaryOutcome> {
    if (!headResult.ok) {
      return { diff_stat: null, commits: null, gitHint: headResult.reason };
    }
    const summary = await summarizeTurn(workspace, headResult.head);
    if (summary.ok) {
      return {
        diff_stat: summary.summary.diff_stat,
        commits: summary.summary.commits,
      };
    }
    return { diff_stat: null, commits: null, gitHint: summary.reason };
  }

  function withGitHint(
    hints: Hints,
    git: GitSummaryOutcome,
  ): Record<string, unknown> | undefined {
    return hintsOrUndefined(
      git.gitHint ? { ...hints, git: git.gitHint } : hints,
    );
  }

  /** `stopReason` 對應的 `error.message`：`timeout` 用實際生效的逾時毫秒數，不是 config 原始值。 */
  function cancelMessage(
    stopReason: StopReason,
    activeTask: ActiveTask,
  ): string {
    if (stopReason === "cancelled") {
      return "cancelled by caller";
    }
    return `turn exceeded ${String(activeTask.timeoutMs)}ms`;
  }

  /**
   * `completed` 終態後才跑 git 摘要：Task 仍是 completed，摘要失敗只影響
   * `diff_stat` / `commits` 為 null 並附 `hints.git`。摘要本身是一段 await，
   * 這段期間 cancel() / 逾時計時器依然可能把 `activeTask.stopReason` 設上；
   * 寫入前重新讀一次，取消／逾時還是贏，但沿用已經算好的這份摘要，不重算。
   */
  async function finishCompleted(
    taskId: string,
    workspace: string,
    headResult: CaptureHeadResult,
    hints: Hints,
    completed: CompletedOutcome,
    activeTask: ActiveTask,
  ): Promise<void> {
    const git = await resolveGitSummary(workspace, headResult);
    const lateStopReason = readStopReason(activeTask);
    if (lateStopReason) {
      markCancelled(taskId, {
        final_text: completed.final_text,
        usage: completed.usage,
        diff_stat: git.diff_stat,
        commits: git.commits,
        hints: withGitHint(hints, git),
        code: lateStopReason,
        message: cancelMessage(lateStopReason, activeTask),
      });
      return;
    }
    markCompleted(taskId, {
      final_text: completed.final_text,
      usage: completed.usage,
      diff_stat: git.diff_stat,
      commits: git.commits,
      hints: withGitHint(hints, git),
    });
  }

  /**
   * 取消／逾時收斂：跟 `finishCompleted` 一樣跑 git 摘要，`final_text` 優先
   * 用 `completed`（driver 剛好在被 kill 前就送出了 completed 事件）的內容，
   * 否則用收到的 `message` 文字依序組起來（沒收到任何文字就是空字串）。
   */
  async function finishCancelled(
    taskId: string,
    workspace: string,
    headResult: CaptureHeadResult,
    turnResult: TurnResult,
    stopReason: StopReason,
    activeTask: ActiveTask,
  ): Promise<void> {
    const git = await resolveGitSummary(workspace, headResult);
    markCancelled(taskId, {
      final_text: turnResult.completed
        ? turnResult.completed.final_text
        : turnResult.messages.join("\n\n"),
      usage: turnResult.completed ? turnResult.completed.usage : null,
      diff_stat: git.diff_stat,
      commits: git.commits,
      hints: withGitHint(turnResult.hints, git),
      code: stopReason,
      message: cancelMessage(stopReason, activeTask),
    });
  }

  function hintsOrUndefined(hints: Hints): Record<string, unknown> | undefined {
    return Object.keys(hints).length > 0 ? hints : undefined;
  }

  return { enqueue, cancel, shutdown };
}
