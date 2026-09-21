import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openTaskStore } from "../../src/store/sqlite.js";
import { cleanupTempDirs, makeTempDir } from "../config/helpers.js";

afterEach(cleanupTempDirs);

describe("openTaskStore", () => {
  it("db_path 所在的巢狀目錄不存在時會自動建立", async () => {
    const dir = await makeTempDir();
    const dbPath = join(
      dir,
      "nested",
      "does",
      "not",
      "exist",
      "agentport.sqlite",
    );

    const store = openTaskStore(dbPath);
    try {
      expect(existsSync(dbPath)).toBe(true);
      const context = store.createContext("stationhub");
      expect(store.getContext(context.context_id)).toEqual(context);
    } finally {
      store.close();
    }
  });
});
