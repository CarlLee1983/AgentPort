import type { Scheduler } from "../../scheduler.js";
import type { TaskStore } from "../../store/sqlite.js";

export interface EnqueueDeps {
  store: TaskStore;
  scheduler: Scheduler;
  caller: string;
}

export interface EnqueueInput {
  context_id: string;
  agent: string;
  prompt: string;
}

export interface EnqueueResult {
  task_id: string;
  context_id: string;
  state: "queued";
}

/**
 * `submit_task` 與 `follow_up` 共用的最後一步：對一個已存在的 Context 建立新
 * Task 並排進 Scheduler 佇列。呼叫端負責先確認 context / agent 有效。
 */
export function createAndEnqueue(
  deps: EnqueueDeps,
  input: EnqueueInput,
): EnqueueResult {
  const task = deps.store.createTask({
    context_id: input.context_id,
    agent: input.agent,
    caller: deps.caller,
    prompt: input.prompt,
  });
  deps.scheduler.enqueue(task.task_id);

  return {
    task_id: task.task_id,
    context_id: input.context_id,
    state: "queued",
  };
}
