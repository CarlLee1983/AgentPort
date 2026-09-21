import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load.js";
import {
  agentToml,
  baseEnv,
  cleanupTempDirs,
  makeFakeExecutable,
  makeTempDir,
  makeWorkspace,
  writeConfigFile,
} from "./helpers.js";

afterEach(cleanupTempDirs);

describe("設定檔預設值與未知欄位", () => {
  it("套用 server / storage 預設值，並展開 db_path、log_dir 裡的 ~", async () => {
    const dir = await makeTempDir();
    const workspace = await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(dir, agentToml());

    const result = loadConfig(configPath, baseEnv({ HOME: dir, PATH: dir }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.server.listen).toBe("127.0.0.1:3333");
    expect(result.config.server.long_poll_max_seconds).toBe(30);
    expect(result.config.storage.db_path).toBe(
      `${dir}/.local/state/agentport/agentport.sqlite`,
    );
    expect(result.config.storage.log_dir).toBe(
      `${dir}/.local/state/agentport/logs`,
    );
    expect(result.config.agents[0]?.workspace).toBe(workspace);
    expect(result.config.callers).toEqual([]);
  });

  it("未知欄位視為錯誤", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      `\ntotally_unknown = true\n${agentToml()}`,
    );

    const result = loadConfig(configPath, baseEnv({ HOME: dir, PATH: dir }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some((e) => e.message.includes("totally_unknown")),
    ).toBe(true);
  });

  it("agents[] 不可為空", async () => {
    const dir = await makeTempDir();
    const configPath = await writeConfigFile(dir, "agents = []\n");

    const result = loadConfig(configPath, baseEnv({ HOME: dir }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      { path: "agents", message: "agents[] 不可為空" },
    ]);
  });

  it("設定檔不存在時回報單一錯誤", () => {
    const result = loadConfig("/no/such/agentport.toml", baseEnv());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe("$");
  });

  it("TOML 語法錯誤時回報單一錯誤", async () => {
    const dir = await makeTempDir();
    const configPath = await writeConfigFile(dir, "agents = [\n");

    const result = loadConfig(configPath, baseEnv({ HOME: dir }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe("$");
  });
});
