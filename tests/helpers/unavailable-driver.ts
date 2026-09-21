import type {
  DriverEvent,
  DriverRegistry,
  RuntimeDriver,
  Turn,
} from "../../src/driver/types.js";

/**
 * 真正的 Runtime Driver 尚未實作（票 04 / 05）。`agentport stdio` 暫時用這個
 * 對兩個 runtime 都立即回報 `failed` 的假 Driver 頂著，讓 stdio 派工流程可先跑通。
 */
function unavailableTurn(): Turn {
  const event: DriverEvent = {
    type: "failed",
    error: "runtime driver not implemented",
  };
  return {
    events: {
      // 每次呼叫都回傳一個全新的、未消耗過的 iterator，讓 `events` 可以被重複迭代。
      [Symbol.asyncIterator]() {
        let done = false;
        return {
          next(): Promise<IteratorResult<DriverEvent>> {
            if (done) {
              return Promise.resolve({ done: true, value: undefined });
            }
            done = true;
            return Promise.resolve({ done: false, value: event });
          },
        };
      },
    },
    kill() {
      // 沒有真正的子程序可殺，不做事。
    },
  };
}

export const unavailableDriver: RuntimeDriver = {
  start() {
    return unavailableTurn();
  },
  resume() {
    return unavailableTurn();
  },
};

export const unavailableDrivers: DriverRegistry = {
  claude: unavailableDriver,
  codex: unavailableDriver,
};
