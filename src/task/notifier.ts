export interface TaskNotifier {
  /**
   * 某個 Task 的狀態剛寫入 store 後呼叫：把該 task 的 revision 加一，並喚醒所有
   * 正在等它的 `waitForChange`。
   */
  notify(taskId: string): void;
  /** 目前的 revision（從未 notify 過的 task 是 0）。 */
  current(taskId: string): number;
  /**
   * 等到 revision 大於 `sinceRevision` 或逾時。呼叫端應先用 `current()` 取得
   * `sinceRevision` 再去讀 task 本身，讓「讀 task 之後、註冊等待之前」這段時間
   * 發生的 notify 反映在 `sinceRevision` 已經落後、`waitForChange` 因而立即
   * 回 `changed`，而不是被吃掉、白等到逾時。
   */
  waitForChange(
    taskId: string,
    sinceRevision: number,
    timeoutMs: number,
  ): Promise<"changed" | "timeout">;
}

/**
 * 純記憶體的 Task 狀態變化通知器：每個 task 一個單調遞增的 revision，`notify`
 * 喚醒當下在等的所有人後就清空 waiter（不記錯過的事件，`get_task` 逾時後會
 * 自己重讀 store），跨程序重啟不保留。
 */
export function createTaskNotifier(): TaskNotifier {
  const revisions = new Map<string, number>();
  const waiters = new Map<string, Set<() => void>>();

  function current(taskId: string): number {
    return revisions.get(taskId) ?? 0;
  }

  function notify(taskId: string): void {
    revisions.set(taskId, current(taskId) + 1);

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
    sinceRevision: number,
    timeoutMs: number,
  ): Promise<"changed" | "timeout"> {
    if (current(taskId) > sinceRevision) {
      return Promise.resolve("changed");
    }

    return new Promise((resolve) => {
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
      }

      function onChange(): void {
        cleanup();
        resolve("changed");
      }

      const timer = setTimeout(() => {
        cleanup();
        resolve("timeout");
      }, timeoutMs);

      waiterSet.add(onChange);
    });
  }

  return { notify, current, waitForChange };
}
