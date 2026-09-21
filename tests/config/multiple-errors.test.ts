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

const CALLER_BLOCK = `
[[callers]]
name = "grok"
token_env = "AGENTPORT_TOKEN_GROK"
`;

describe("多個錯誤同時存在", () => {
  it("同時有 agent name 重複、workspace 不存在、token_env 為空三種錯誤時，三條都列出", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace-a");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      `${agentToml({ workspace: "workspace-a" })}${agentToml({ workspace: "does-not-exist" })}${CALLER_BLOCK}`,
    );

    const result = loadConfig(
      configPath,
      baseEnv({ HOME: dir, PATH: dir, AGENTPORT_TOKEN_GROK: "" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.errors.map((e) => e.path).sort();
    expect(paths).toEqual(
      ["agents[1].name", "agents[1].workspace", "callers[0].token_env"].sort(),
    );
  });

  it("zod 結構錯誤與語意錯誤混合時，通過結構驗證的項目仍會跑語意驗證，三條都列出", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace-a");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(
      dir,
      `${agentToml({ workspace: "workspace-a" })}${agentToml({
        name: "broken-policy",
        workspace: "workspace-a",
        policy: "god-mode",
      })}${agentToml({
        name: "missing-workspace",
        workspace: "does-not-exist",
      })}${CALLER_BLOCK}`,
    );

    const result = loadConfig(
      configPath,
      baseEnv({ HOME: dir, PATH: dir, AGENTPORT_TOKEN_GROK: "" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.errors.map((e) => e.path).sort();
    expect(paths).toEqual(
      [
        "agents[1].policy",
        "agents[2].workspace",
        "callers[0].token_env",
      ].sort(),
    );
  });
});
