export interface TaskNotifier {
  /** 某個 Task 的狀態剛寫入 store 後呼叫，喚醒所有正在等它的 `waitForChange`。 */
  notify(taskId: string): void;
  /**
   * 等到 `notify(taskId)` 被呼叫或逾時。純記憶體、跨程序重啟不保留；`signal`
   * 允許呼叫端提前放棄等待（視同逾時）。
   */
  waitForChange(
    taskId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<"changed" | "timeout">;
}

/**
 * 純記憶體的 Task 狀態變化通知器：每個 task 一組 waiter，`notify` 喚醒當下
 * 在等的所有人後就清空，不記錯過的事件（get-task 逾時後會自己重讀 store）。
 */
export function createTaskNotifier(): TaskNotifier {
  const waiters = new Map<string, Set<() => void>>();

  function notify(taskId: string): void {
    const set = waiters.get(taskId);
    if (!set) {
      return;
    }
    waiters.delete(taskId);
    for (const resolve of set) {
      resolve();
    }
  }

  function waitForChange(
    taskId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<"changed" | "timeout"> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve("timeout");
        return;
      }

      let set = waiters.get(taskId);
      if (!set) {
        set = new Set();
        waiters.set(taskId, set);
      }
      const waiterSet = set;

      function cleanup(): void {
        clearTimeout(timer);
        waiterSet.delete(onChange);
        if (waiterSet.size === 0) {
          waiters.delete(taskId);
        }
        signal?.removeEventListener("abort", onAbort);
      }

      function onChange(): void {
        cleanup();
        resolve("changed");
      }

      function onAbort(): void {
        cleanup();
        resolve("timeout");
      }

      const timer = setTimeout(() => {
        cleanup();
        resolve("timeout");
      }, timeoutMs);

      waiterSet.add(onChange);
      signal?.addEventListener("abort", onAbort);
    });
  }

  return { notify, waitForChange };
}
