import type { Config } from "./config/schema.js";
import type { DriverEvent, DriverRegistry } from "./driver/types.js";
import { openRawLog, type RawLog } from "./logs/jsonl.js";
import type { TaskRecord, TaskStore } from "./store/sqlite.js";

export interface SchedulerDeps {
  store: TaskStore;
  drivers: DriverRegistry;
  config: Config;
}

export interface Scheduler {
  enqueue(taskId: string): void;
}

type Hints = { permission_denied?: unknown[] };

interface EventOutcome {
  hints: Hints;
  terminal: boolean;
}

/**
 * 單一序列 worker：所有 Task 排在同一條 promise chain 上依序執行（票 02 範圍，
 * 每 agent 一條 FIFO 的並行版本留給後續票）。`runTask` 內任何例外都在自己的
 * try/catch 收斂成 `markFailed`，`.catch` 只是防止鏈斷掉的最後防線。
 */
export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { store, drivers, config } = deps;
  let chain: Promise<void> = Promise.resolve();

  function enqueue(taskId: string): void {
    chain = chain
      .then(() => runTask(taskId))
      .catch((error: unknown) => {
        console.error(
          `[scheduler] task ${taskId} 執行時發生未預期例外：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
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
        store.markFailed(taskId, {
          code: "runtime_failed",
          message: `未知 agent：${task.agent}`,
        });
        return;
      }

      rawLog = openRawLog(config.storage.log_dir, taskId);
      store.markRunning(taskId, rawLog.path);

      const driver = drivers[agent.runtime];
      const context = store.getContext(task.context_id);
      const turnInput = {
        workspace: agent.workspace,
        prompt: task.prompt,
        policy: agent.policy,
        extra_args: agent.extra_args ?? [],
      };
      const turn =
        context?.runtime_session_id !== null &&
        context?.runtime_session_id !== undefined
          ? driver.resume({
              ...turnInput,
              runtime_session_id: context.runtime_session_id,
            })
          : driver.start(turnInput);

      let hints: Hints = {};
      let terminal = false;
      for await (const event of turn.events) {
        rawLog.write(event);
        if (terminal) {
          // 已經收到終態事件（completed / failed），忽略之後送來的事件，不覆寫結果。
          continue;
        }
        const outcome = handleEvent(task, hints, event);
        hints = outcome.hints;
        terminal = outcome.terminal;
      }

      if (!terminal) {
        store.markFailed(taskId, {
          code: "runtime_failed",
          message: "driver ended without terminal event",
          hints: hintsOrUndefined(hints),
        });
      }
    } catch (error) {
      store.markFailed(taskId, {
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
  ): EventOutcome {
    switch (event.type) {
      case "started":
        store.setRuntimeSession(task.context_id, event.runtime_session_id);
        return { hints, terminal: false };
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
        store.markCompleted(task.task_id, {
          final_text: event.final_text,
          usage: event.usage,
          hints: hintsOrUndefined(hints),
        });
        return { hints, terminal: true };
      case "failed":
        store.markFailed(task.task_id, {
          code: "runtime_failed",
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

  function hintsOrUndefined(hints: Hints): Record<string, unknown> | undefined {
    return Object.keys(hints).length > 0 ? hints : undefined;
  }

  return { enqueue };
}
