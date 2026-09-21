import { chmod } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load.js";
import {
  baseEnv,
  cleanupTempDirs,
  makeTempDir,
  writeConfigFile,
} from "./helpers.js";

afterEach(cleanupTempDirs);

describe("讀檔失敗訊息帶 errno 資訊", () => {
  it("ENOENT：檔案不存在", () => {
    const result = loadConfig("/no/such/agentport.toml", baseEnv());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe("$");
    expect(result.errors[0]?.message).toContain("不存在");
  });

  it("EISDIR：路徑指向目錄", async () => {
    const dir = await makeTempDir();

    const result = loadConfig(dir, baseEnv({ HOME: dir }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe("$");
    expect(result.errors[0]?.message).toContain("目錄");
  });

  it("EACCES：沒有讀取權限", async () => {
    const dir = await makeTempDir();
    const configPath = await writeConfigFile(dir, "agents = []\n");
    await chmod(configPath, 0o000);

    try {
      const result = loadConfig(configPath, baseEnv({ HOME: dir }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.path).toBe("$");
      expect(result.errors[0]?.message).toContain("權限");
    } finally {
      await chmod(configPath, 0o644);
    }
  });
});
