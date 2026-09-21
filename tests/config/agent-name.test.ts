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

describe("Logical Agent 的 name 規則", () => {
  it("name 含大寫字母時回報錯誤", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      agentToml({ name: "StationHub" }),
    );

    const result = loadConfig(configPath, baseEnv({ HOME: dir, PATH: dir }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.path === "agents[0].name")).toBe(true);
  });

  it("兩個 Agent 使用相同 name 時回報錯誤", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace-a");
    await makeWorkspace(dir, "workspace-b");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      `${agentToml({ workspace: "workspace-a" })}${agentToml({ workspace: "workspace-b" })}`,
    );

    const result = loadConfig(configPath, baseEnv({ HOME: dir, PATH: dir }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      path: "agents[1].name",
      message: "agent name 重複：與 agents[0] 相同",
    });
  });
});
