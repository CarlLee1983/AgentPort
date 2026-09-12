import { describe, expect, it } from "vitest";

import { probeSqliteCompatibility } from "../compatibility/sqlite-probe.js";

describe("AP-001 SQLite compatibility", () => {
  it("loads the fixed binding in a worker and reports the embedded runtime", async () => {
    let eventLoopAdvanced = false;
    setImmediate(() => {
      eventLoopAdvanced = true;
    });

    const result = await probeSqliteCompatibility();

    expect(result).toEqual({
      bindingVersion: "13.0.3",
      sqliteVersion: "3.53.4",
      journalMode: "wal",
    });
    expect(eventLoopAdvanced).toBe(true);
  });
});
