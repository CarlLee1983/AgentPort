import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load.js";
import {
  agentToml,
  baseEnv,
  cleanupTempDirs,
  makeTempDir,
  makeWorkspace,
  writeConfigFile,
} from "./helpers.js";

afterEach(cleanupTempDirs);

describe("Runtime 與 policy 列舉", () => {
  it("runtime 不在 claude | codex 之列時回報錯誤", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    const configPath = await writeConfigFile(
      dir,
      agentToml({ runtime: "cursor" }),
    );

    const result = loadConfig(configPath, baseEnv({ HOME: dir }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.path === "agents[0].runtime")).toBe(
      true,
    );
  });

  it("policy 未填時回報錯誤（必填）", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    const configPath = await writeConfigFile(
      dir,
      agentToml({ policy: undefined }),
    );

    const result = loadConfig(configPath, baseEnv({ HOME: dir }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.path === "agents[0].policy")).toBe(true);
  });

  it("policy 值不在三級之列時回報錯誤", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    const configPath = await writeConfigFile(
      dir,
      agentToml({ policy: "god-mode" }),
    );

    const result = loadConfig(configPath, baseEnv({ HOME: dir }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.path === "agents[0].policy")).toBe(true);
  });
});
