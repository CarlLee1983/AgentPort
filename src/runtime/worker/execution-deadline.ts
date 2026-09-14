/** Monotonic accumulated execution deadline; durable pure waiting may pause it. */
export class ActiveExecutionDeadline {
  readonly abortController = new AbortController();
  #remainingMilliseconds: number;
  #startedAt = performance.now();
  #timer: NodeJS.Timeout | undefined;
  expired = false;

  constructor(limitSeconds: number) {
    this.#remainingMilliseconds = limitSeconds * 1_000;
    this.#schedule();
  }

  pause(): void {
    if (this.#timer === undefined || this.abortController.signal.aborted)
      return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#remainingMilliseconds = Math.max(
      0,
      this.#remainingMilliseconds - (performance.now() - this.#startedAt),
    );
  }

  resume(): void {
    if (this.#timer !== undefined || this.abortController.signal.aborted)
      return;
    this.#startedAt = performance.now();
    this.#schedule();
  }

  dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(): void {
    if (this.#remainingMilliseconds <= 0) {
      this.expired = true;
      this.abortController.abort();
      return;
    }
    this.#startedAt = performance.now();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#remainingMilliseconds = 0;
      this.expired = true;
      this.abortController.abort();
    }, this.#remainingMilliseconds);
    this.#timer.unref();
  }
}
