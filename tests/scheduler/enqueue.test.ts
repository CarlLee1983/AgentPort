import { describe, expect, it, vi } from "vitest";

import type { Config } from "../../src/config/schema.js";
import type { DriverRegistry } from "../../src/driver/types.js";
import { createScheduler } from "../../src/scheduler.js";
import type { TaskStore } from "../../src/store/sqlite.js";
import { createTaskNotifier } from "../../src/task/notifier.js";

/** 除了測試會用到的 `getTask` 外，其他方法都不該被呼叫到；呼叫就丟例外讓測試爆炸。 */
function unusedStoreMethod(name: string): () => never {
  return () => {
    throw new Error(
      `不應該呼叫 store.${name}：taskId 不存在時 enqueue 應該提早 return`,
    );
  };
}

describe("createScheduler().enqueue", () => {
  it("taskId 在 store 裡找不到時直接 return，不建立幽靈 chain、不呼叫任何 Driver", async () => {
    const getTask = vi.fn().mockReturnValue(undefined);
    const store = {
      getTask,
      createContext: unusedStoreMethod("createContext"),
      createTask: unusedStoreMethod("createTask"),
      getContext: unusedStoreMethod("getContext"),
      listTasks: unusedStoreMethod("listTasks"),
      markRunning: unusedStoreMethod("markRunning"),
      setRuntimeSession: unusedStoreMethod("setRuntimeSession"),
      markCompleted: unusedStoreMethod("markCompleted"),
      markFailed: unusedStoreMethod("markFailed"),
      close: unusedStoreMethod("close"),
    } as unknown as TaskStore;

    const start = vi.fn();
    const drivers = {
      claude: { start, resume: vi.fn() },
      codex: { start, resume: vi.fn() },
    } as unknown as DriverRegistry;

    const config = { agents: [] } as unknown as Config;
    const notifier = createTaskNotifier();
    const scheduler = createScheduler({ store, drivers, config, notifier });

    expect(() => {
      scheduler.enqueue("does-not-exist");
    }).not.toThrow();

    // enqueue 內部的執行是非同步 chain，讓 microtask 跑完確認真的沒有觸發任何後續動作。
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 找不到 task 應該在 enqueue 裡就直接 return：只讀一次 store，不再接進
    // `runTask`（`?? taskId` 開的幽靈 chain會讓 runTask 也跑一次、再讀一次）。
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(getTask).toHaveBeenCalledWith("does-not-exist");
    expect(start).not.toHaveBeenCalled();
  });
});
