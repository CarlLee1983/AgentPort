import { afterEach, describe, expect, it } from "vitest";

import { unavailableDrivers } from "../../src/driver/unavailable.js";
import { cleanupTempDirs } from "../config/helpers.js";
import { createTestApp } from "../helpers/app.js";

afterEach(cleanupTempDirs);

describe("get_task", () => {
  it("不存在的 task_id 回 not_found", async () => {
    const app = await createTestApp(unavailableDrivers);
    try {
      const response = await app.client.callTool({
        name: "get_task",
        arguments: { task_id: "no-such-task" },
      });

      expect(response.isError).toBe(true);
      expect(response.structuredContent).toEqual({
        error: { code: "not_found", message: expect.any(String) as unknown },
      });
    } finally {
      await app.close();
    }
  });
});
