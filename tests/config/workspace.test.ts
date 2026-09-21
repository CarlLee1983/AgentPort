import { symlink } from "node:fs/promises";
import { join } from "node:path";

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

describe("Workspace 綁定規則", () => {
  it("workspace 不存在時回報錯誤", async () => {
    const dir = await makeTempDir();
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      agentToml({ workspace: "does-not-exist" }),
    );

    const result = loadConfig(configPath, baseEnv({ HOME: dir, PATH: dir }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      path: "agents[0].workspace",
      message: `workspace 不存在：${join(dir, "does-not-exist")}`,
    });
  });

  it("workspace 指向檔案而非目錄時回報錯誤", async () => {
    const dir = await makeTempDir();
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      agentToml({ workspace: "agentport.toml" }),
    );

    const result = loadConfig(configPath, baseEnv({ HOME: dir, PATH: dir }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some(
        (e) =>
          e.path === "agents[0].workspace" && e.message.includes("不是目錄"),
      ),
    ).toBe(true);
  });

  it("兩個 Agent 綁定同一 realpath 的 workspace 時回報錯誤", async () => {
    const dir = await makeTempDir();
    const workspace = await makeWorkspace(dir, "workspace");
    const symlinkPath = join(dir, "workspace-alias");
    await symlink(workspace, symlinkPath);
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      `${agentToml({ name: "primary", workspace: "workspace" })}${agentToml({
        name: "secondary",
        workspace: "workspace-alias",
      })}`,
    );

    const result = loadConfig(configPath, baseEnv({ HOME: dir, PATH: dir }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      path: "agents[1].workspace",
      message: `workspace 已綁定給 agents[0]：${symlinkPath}`,
    });
  });
});
