import { afterEach, describe, expect, it } from "vitest";

import { unavailableDrivers } from "../../src/driver/unavailable.js";
import { cleanupTempDirs } from "../config/helpers.js";
import { createTestApp } from "../helpers/app.js";

afterEach(cleanupTempDirs);

describe("list_agents", () => {
  it("回傳設定檔內的 agent 清單", async () => {
    const app = await createTestApp(unavailableDrivers);
    try {
      const response = await app.client.callTool({
        name: "list_agents",
        arguments: {},
      });

      expect(response.isError).toBeFalsy();
      expect(response.structuredContent).toEqual({
        agents: [
          {
            name: "stationhub",
            runtime: "claude",
            policy: "workspace-write",
          },
        ],
      });
      expect(response.content[0]).toMatchObject({ type: "text" });
      expect(
        JSON.parse((response.content[0] as { text: string }).text),
      ).toEqual(response.structuredContent);
    } finally {
      await app.close();
    }
  });
});
