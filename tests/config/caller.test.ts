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

const AGENT_BLOCK = agentToml();

describe("Caller 規則", () => {
  it("兩個 Caller 使用相同 name 時回報錯誤", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      `${AGENT_BLOCK}
[[callers]]
name = "grok"
token_env = "AGENTPORT_TOKEN_GROK"

[[callers]]
name = "grok"
token_env = "AGENTPORT_TOKEN_GROK_2"
`,
    );

    const result = loadConfig(
      configPath,
      baseEnv({
        HOME: dir,
        PATH: dir,
        AGENTPORT_TOKEN_GROK: "token-a",
        AGENTPORT_TOKEN_GROK_2: "token-b",
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      path: "callers[1].name",
      message: "caller name 重複：與 callers[0] 相同",
    });
  });

  it("token_env 指向的環境變數未設定或為空時回報錯誤", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      `${AGENT_BLOCK}
[[callers]]
name = "grok"
token_env = "AGENTPORT_TOKEN_GROK"
`,
    );

    const result = loadConfig(
      configPath,
      baseEnv({ HOME: dir, PATH: dir, AGENTPORT_TOKEN_GROK: "" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      path: "callers[0].token_env",
      message: "環境變數 AGENTPORT_TOKEN_GROK 未設定或為空",
    });
  });

  it("兩個 Caller 解析出相同 token 值時回報錯誤", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      `${AGENT_BLOCK}
[[callers]]
name = "grok"
token_env = "AGENTPORT_TOKEN_GROK"

[[callers]]
name = "other"
token_env = "AGENTPORT_TOKEN_OTHER"
`,
    );

    const result = loadConfig(
      configPath,
      baseEnv({
        HOME: dir,
        PATH: dir,
        AGENTPORT_TOKEN_GROK: "same-token",
        AGENTPORT_TOKEN_OTHER: "same-token",
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      path: "callers[1].token_env",
      message: "token 與 callers[0] 重複",
    });
  });
});
