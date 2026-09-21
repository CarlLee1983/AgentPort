import type { Config } from "../config/schema.js";
import { createClaudeDriver } from "./claude/index.js";
import { createCodexDriver } from "./codex/index.js";
import type { DriverRegistry } from "./types.js";

/** 依設定檔的 `[runtimes.*].command` 建出兩個真 Driver；未設時走 PATH 裸名。 */
export function createDrivers(
  config: Config,
  env: NodeJS.ProcessEnv,
): DriverRegistry {
  return {
    claude: createClaudeDriver({
      command: config.runtimes.claude.command,
      env,
    }),
    codex: createCodexDriver({
      command: config.runtimes.codex.command,
      env,
    }),
  };
}
