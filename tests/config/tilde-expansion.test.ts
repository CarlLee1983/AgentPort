import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load.js";
import {
  agentToml,
  baseEnv,
  cleanupTempDirs,
  makeFakeExecutable,
  makeTempDir,
  writeConfigFile,
} from "./helpers.js";

afterEach(cleanupTempDirs);

describe("HOME 未設定時的 ~ 展開", () => {
  it("env.HOME 未設定且路徑含 ~ 時回報 ConfigError，不展成相對路徑", async () => {
    const dir = await makeTempDir();
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      agentToml({ workspace: "~/workspace" }),
    );

    const result = loadConfig(
      configPath,
      baseEnv({ HOME: undefined, PATH: dir }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some(
        (e) => e.path === "agents[0].workspace" && e.message.includes("~"),
      ),
    ).toBe(true);
  });
});
