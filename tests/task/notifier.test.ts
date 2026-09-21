import { describe, expect, it } from "vitest";

import { createTaskNotifier } from "../../src/task/notifier.js";

describe("createTaskNotifier", () => {
  it("先 notify 再 wait 必須立即回 changed，不漏掉已發生的事件", async () => {
    const notifier = createTaskNotifier();
    const taskId = "task-1";

    const sinceRevision = notifier.current(taskId);
    notifier.notify(taskId);

    const outcome = await notifier.waitForChange(taskId, sinceRevision, 1000);
    expect(outcome).toBe("changed");
  });

  it("沒有 notify 時逾時回 timeout", async () => {
    const notifier = createTaskNotifier();
    const taskId = "task-2";

    const outcome = await notifier.waitForChange(
      taskId,
      notifier.current(taskId),
      20,
    );
    expect(outcome).toBe("timeout");
  });

  it("wait 之後才 notify 也會被喚醒", async () => {
    const notifier = createTaskNotifier();
    const taskId = "task-3";

    const sinceRevision = notifier.current(taskId);
    const waiting = notifier.waitForChange(taskId, sinceRevision, 1000);
    notifier.notify(taskId);

    expect(await waiting).toBe("changed");
  });

  it("current() 隨每次 notify 遞增，可用來偵測是否已經是最新版本", () => {
    const notifier = createTaskNotifier();
    const taskId = "task-4";

    expect(notifier.current(taskId)).toBe(0);
    notifier.notify(taskId);
    expect(notifier.current(taskId)).toBe(1);
    notifier.notify(taskId);
    expect(notifier.current(taskId)).toBe(2);
  });
});
