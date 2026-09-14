import { afterEach, describe, expect, it, vi } from "vitest";

import { ActiveExecutionDeadline } from "../../src/runtime/worker/execution-deadline.js";

describe("Runtime accumulated execution deadline", () => {
  afterEach(() => vi.useRealTimers());

  it("counts active time but excludes an explicitly paused pure wait", () => {
    vi.useFakeTimers();
    const deadline = new ActiveExecutionDeadline(1);
    vi.advanceTimersByTime(500);
    deadline.pause();
    vi.advanceTimersByTime(5_000);
    expect(deadline.abortController.signal.aborted).toBe(false);

    deadline.resume();
    vi.advanceTimersByTime(499);
    expect(deadline.abortController.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(deadline.abortController.signal.aborted).toBe(true);
    expect(deadline.expired).toBe(true);
    deadline.dispose();
  });
});
