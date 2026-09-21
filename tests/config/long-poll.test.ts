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

describe("long_poll_max_seconds 上限", () => {
  it("超過 55 秒時回報錯誤", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      `\n[server]\nlong_poll_max_seconds = 56\n${agentToml()}`,
    );

    const result = loadConfig(configPath, baseEnv({ HOME: dir, PATH: dir }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some((e) => e.path === "server.long_poll_max_seconds"),
    ).toBe(true);
  });

  it("55 秒為合法上限", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      `\n[server]\nlong_poll_max_seconds = 55\n${agentToml()}`,
    );

    const result = loadConfig(configPath, baseEnv({ HOME: dir, PATH: dir }));

    expect(result.ok).toBe(true);
  });
});
