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

describe("[server] turn_timeout_seconds", () => {
  it("預設 3600 秒", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(dir, agentToml());

    const result = loadConfig(configPath, baseEnv({ HOME: dir, PATH: dir }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.server.turn_timeout_seconds).toBe(3600);
  });

  it("接受自訂值", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      `\n[server]\nturn_timeout_seconds = 120\n${agentToml()}`,
    );

    const result = loadConfig(configPath, baseEnv({ HOME: dir, PATH: dir }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.server.turn_timeout_seconds).toBe(120);
  });

  it("0 秒不合法", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      `\n[server]\nturn_timeout_seconds = 0\n${agentToml()}`,
    );

    const result = loadConfig(configPath, baseEnv({ HOME: dir, PATH: dir }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some((e) => e.path === "server.turn_timeout_seconds"),
    ).toBe(true);
  });

  it("非整數不合法", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      `\n[server]\nturn_timeout_seconds = 1.5\n${agentToml()}`,
    );

    const result = loadConfig(configPath, baseEnv({ HOME: dir, PATH: dir }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some((e) => e.path === "server.turn_timeout_seconds"),
    ).toBe(true);
  });
});
