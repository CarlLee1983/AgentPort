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

describe("Runtime 可執行檔存在", () => {
  it("PATH 裡找不到 runtime 可執行檔時回報錯誤", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    const emptyBinDir = await makeTempDir();
    const configPath = await writeConfigFile(dir, agentToml());

    const result = loadConfig(
      configPath,
      baseEnv({ HOME: dir, PATH: emptyBinDir }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      path: "runtimes.claude.command",
      message: "在 PATH 中找不到可執行檔：claude",
    });
  });

  it("PATH 裡找得到 runtime 可執行檔時通過驗證", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(dir, agentToml());

    const result = loadConfig(configPath, baseEnv({ HOME: dir, PATH: dir }));

    expect(result.ok).toBe(true);
  });

  it("`[runtimes.<r>].command` 指向不存在的檔案時回報錯誤，即使 PATH 有同名可執行檔", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      `\n[runtimes.claude]\ncommand = "~/.local/bin/claude"\n${agentToml()}`,
    );

    const result = loadConfig(configPath, baseEnv({ HOME: dir, PATH: dir }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      path: "runtimes.claude.command",
      message: `runtime 執行檔不存在或不可執行：${dir}/.local/bin/claude`,
    });
  });

  it("`[runtimes.<r>].command` 為裸名時走 PATH 查找，而非展開成設定檔目錄下路徑", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    // 設定檔目錄下剛好也有一個叫 claude 的檔案，用來證明裸名不會被錯誤地展開成這個路徑。
    await makeFakeExecutable(dir, "claude");
    const pathDir = await makeTempDir();
    await makeFakeExecutable(pathDir, "claude");
    const configPath = await writeConfigFile(
      dir,
      `\n[runtimes.claude]\ncommand = "claude"\n${agentToml()}`,
    );

    const result = loadConfig(
      configPath,
      baseEnv({ HOME: dir, PATH: pathDir }),
    );

    expect(result.ok).toBe(true);
  });

  it("`[runtimes.<r>].command` 為裸名且 PATH 中找不到時回報錯誤，即使設定檔目錄下有同名檔案", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const emptyBinDir = await makeTempDir();
    const configPath = await writeConfigFile(
      dir,
      `\n[runtimes.claude]\ncommand = "claude"\n${agentToml()}`,
    );

    const result = loadConfig(
      configPath,
      baseEnv({ HOME: dir, PATH: emptyBinDir }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      path: "runtimes.claude.command",
      message: "在 PATH 中找不到可執行檔：claude",
    });
  });

  it("`[runtimes.<r>].command` 展開 ~ 後指向可執行檔時通過驗證", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude-custom");
    const configPath = await writeConfigFile(
      dir,
      `\n[runtimes.claude]\ncommand = "~/claude-custom"\n${agentToml()}`,
    );

    const result = loadConfig(configPath, baseEnv({ HOME: dir, PATH: "" }));

    expect(result.ok).toBe(true);
  });

  it("`[runtimes.<r>].command` 含 / 的相對路徑會展開成設定檔目錄下路徑", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeWorkspace(dir, "bin");
    await makeFakeExecutable(dir, "bin/claude-custom");
    const configPath = await writeConfigFile(
      dir,
      `\n[runtimes.claude]\ncommand = "bin/claude-custom"\n${agentToml()}`,
    );

    const result = loadConfig(configPath, baseEnv({ HOME: dir, PATH: "" }));

    expect(result.ok).toBe(true);
  });
});
