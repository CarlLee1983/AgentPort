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

describe("server.listen 非 loopback 時必須設定 server.allowed_hosts", () => {
  it("listen 是非 loopback 位址且未設 allowed_hosts 時回報錯誤", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      `\n[server]\nlisten = "0.0.0.0:3333"\n${agentToml()}`,
    );

    const result = loadConfig(configPath, baseEnv({ HOME: dir, PATH: dir }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      path: "server.allowed_hosts",
      message: "非 loopback 監聽必須設定 server.allowed_hosts",
    });
  });

  it("listen 是非 loopback 位址但設了 allowed_hosts 時通過", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      `\n[server]\nlisten = "0.0.0.0:3333"\nallowed_hosts = ["myhost.lan"]\n${agentToml()}`,
    );

    const result = loadConfig(configPath, baseEnv({ HOME: dir, PATH: dir }));

    expect(result.ok).toBe(true);
  });

  it("listen 是 loopback 位址時不需要 allowed_hosts", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      `\n[server]\nlisten = "127.0.0.1:3333"\n${agentToml()}`,
    );

    const result = loadConfig(configPath, baseEnv({ HOME: dir, PATH: dir }));

    expect(result.ok).toBe(true);
  });
});
