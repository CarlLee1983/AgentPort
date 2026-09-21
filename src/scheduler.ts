import type { Config } from "./config/schema.js";
import type { DriverEvent, DriverRegistry } from "./driver/types.js";
import {
  captureHead,
  summarizeTurn,
  type CaptureHeadResult,
} from "./git/summary.js";
import { openRawLog, type RawLog } from "./logs/jsonl.js";
import type { TaskRecord, TaskStore } from "./store/sqlite.js";
import type { TaskNotifier } from "./task/notifier.js";
import type { Hints } from "./task/schema.js";

export interface SchedulerDeps {
  store: TaskStore;
  drivers: DriverRegistry;
  config: Config;
  notifier: TaskNotifier;
}

export interface Scheduler {
  enqueue(taskId: string): void;
}

interface CompletedOutcome {
  final_text: string;
  usage: Record<string, number> | null;
}

interface EventOutcome {
  hints: Hints;
  terminal: boolean;
  completed?: CompletedOutcome;
  /** 這個事件是不是剛剛才把 `runtime_session_id` 回填進 context。 */
  filledRuntimeSession?: boolean;
}

/**
 * 每 agent 一條 FIFO promise chain：同一 agent 的 Task 依序執行，不同 agent
 * 並行，無上限。`enqueue` 在呼叫當下讀 task 決定要接到哪條 chain 後面，`runTask`
 * 內任何例外都在自己的 try/catch 收斂成 `markFailed`，`.catch` 只是防止鏈斷掉
 * 的最後防線。
 */
export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { store, drivers, config, notifier } = deps;
  const chains = new Map<string, Promise<void>>();

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

  async function runTask(taskId: string): Promise<void> {
    let rawLog: RawLog | undefined;
    try {
      const task = store.getTask(taskId);
      if (!task) {
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

      // captureHead 失敗不阻擋 Turn：先記下結果，等 completed 時再決定要不要跑
      // summarizeTurn（見 finishCompleted）。
      const headResult = await captureHead(agent.workspace);

      const driver = drivers[agent.runtime];
      const context = store.getContext(task.context_id);
      const turnInput = {
        workspace: agent.workspace,
        prompt: task.prompt,
        policy: agent.policy,
        extra_args: agent.extra_args ?? [],
      };
      const hooks = { onRawLine: (line: string) => rawLog?.writeLine(line) };
      const turn =
        context?.runtime_session_id !== null &&
        context?.runtime_session_id !== undefined
          ? driver.resume(
              {
                ...turnInput,
                runtime_session_id: context.runtime_session_id,
              },
              hooks,
            )
          : driver.start(turnInput, hooks);

      // 第一個 Task 才回填 runtime_session_id（spec）：resume 的 Task 一開始
      // context 就已經有值，之後收到的 `started` 事件（不管是同一個 Task 內
      // 重複送，或這個 run 本身就是 resume）都不該覆寫掉原本的值。
      let hasRuntimeSession =
        context?.runtime_session_id !== null &&
        context?.runtime_session_id !== undefined;

      let hints: Hints = {};
      let terminal = false;
      let completed: CompletedOutcome | undefined;
      for await (const event of turn.events) {
        if (terminal) {
          // 已經收到終態事件（completed / failed），忽略之後送來的事件，不覆寫結果。
          continue;
        }
        const outcome = handleEvent(task, hints, event, hasRuntimeSession);
        hints = outcome.hints;
        terminal = outcome.terminal;
        completed = outcome.completed;
        if (outcome.filledRuntimeSession) {
          hasRuntimeSession = true;
        }
      }

      if (completed) {
        await finishCompleted(
          taskId,
          agent.workspace,
          headResult,
          hints,
          completed,
        );
      } else if (!terminal) {
        markFailed(taskId, {
          code: "runtime_failed",
          message: "driver ended without terminal event",
          hints: hintsOrUndefined(hints),
        });
      }
    } catch (error) {
      markFailed(taskId, {
        code: "runtime_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      rawLog?.close();
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
        markFailed(task.task_id, {
          code: event.code ?? "runtime_failed",
          message: event.error,
          hints: hintsOrUndefined(hints),
        });
        return { hints, terminal: true };
      case "message":
      case "activity":
        // 這張票不記錄中間文字與活動摘要，final_text 只來自 completed 事件。
        return { hints, terminal: false };
    }
  }

  /**
   * `completed` 終態後才跑 git 摘要：`captureHead` 已經失敗就不用再跑
   * `summarizeTurn`（結果只會是同一種錯），直接把原因記到 `hints.git`。成功時
   * 才呼叫 `summarizeTurn`：成功把 `diff_stat` / `commits` 一起寫進
   * `markCompleted`；失敗（非 git 目錄、git 指令出錯）Task 仍是 completed，
   * 兩欄為 null 並把原因記在 `hints.git`。
   */
  async function finishCompleted(
    taskId: string,
    workspace: string,
    headResult: CaptureHeadResult,
    hints: Hints,
    completed: CompletedOutcome,
  ): Promise<void> {
    if (!headResult.ok) {
      markCompleted(taskId, {
        final_text: completed.final_text,
        usage: completed.usage,
        diff_stat: null,
        commits: null,
        hints: hintsOrUndefined({ ...hints, git: headResult.reason }),
      });
      return;
    }

    const summary = await summarizeTurn(workspace, headResult.head);
    if (summary.ok) {
      markCompleted(taskId, {
        final_text: completed.final_text,
        usage: completed.usage,
        diff_stat: summary.summary.diff_stat,
        commits: summary.summary.commits,
        hints: hintsOrUndefined(hints),
      });
    } else {
      markCompleted(taskId, {
        final_text: completed.final_text,
        usage: completed.usage,
        diff_stat: null,
        commits: null,
        hints: hintsOrUndefined({ ...hints, git: summary.reason }),
      });
    }
  }

  function hintsOrUndefined(hints: Hints): Record<string, unknown> | undefined {
    return Object.keys(hints).length > 0 ? hints : undefined;
  }

  return { enqueue };
}
