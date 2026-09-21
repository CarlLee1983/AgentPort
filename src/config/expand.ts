import { expandPath, HomeNotSetError, type Env } from "./paths.js";
import { RUNTIME_NAMES, type Agent, type Config } from "./schema.js";
import type { ConfigError } from "./errors.js";

export interface IndexedAgent {
  index: number;
  value: Agent;
}

export interface ExpandConfigResult {
  storage: Config["storage"];
  runtimes: Config["runtimes"];
  agents: IndexedAgent[];
  errors: ConfigError[];
}

/**
 * 是否要展開成絕對路徑：只有含 `/` 或以 `~` 開頭的值才展開；
 * 裸名（如 `claude`）留給呼叫端走 `PATH` 查找，不展開成設定檔目錄下的路徑。
 */
function needsExpansion(value: string): boolean {
  return value.includes("/") || value.startsWith("~");
}

function expandOrRecordError(
  value: string,
  home: string | undefined,
  baseDir: string,
  path: string,
  errors: ConfigError[],
): string {
  try {
    return expandPath(value, { home, baseDir });
  } catch (error) {
    if (error instanceof HomeNotSetError) {
      errors.push({ path, message: error.message });
      return value;
    }
    throw error;
  }
}

/**
 * 把設定值裡的路徑展開：`~` 相對於 `env.HOME`，相對路徑相對於設定檔目錄 `baseDir`。
 * `runtimes.*.command` 為裸名時不展開，留給語意驗證走 PATH 查找。
 * 展開時若需要 `~` 但 `HOME` 未設定，收集為 ConfigError 而非展成錯誤的相對路徑。
 */
export function expandConfigPaths(
  shape: { storage: Config["storage"]; runtimes: Config["runtimes"] },
  agents: IndexedAgent[],
  env: Env,
  baseDir: string,
): ExpandConfigResult {
  const { HOME: home } = env;
  const errors: ConfigError[] = [];

  const storage = {
    db_path: expandOrRecordError(
      shape.storage.db_path,
      home,
      baseDir,
      "storage.db_path",
      errors,
    ),
    log_dir: expandOrRecordError(
      shape.storage.log_dir,
      home,
      baseDir,
      "storage.log_dir",
      errors,
    ),
  };

  const runtimes = { ...shape.runtimes };
  for (const name of RUNTIME_NAMES) {
    const command = shape.runtimes[name].command;
    const expandedCommand = needsExpansion(command)
      ? expandOrRecordError(
          command,
          home,
          baseDir,
          `runtimes.${name}.command`,
          errors,
        )
      : command;
    runtimes[name] = { command: expandedCommand };
  }

  const expandedAgents = agents.map(({ index, value }) => ({
    index,
    value: {
      ...value,
      workspace: expandOrRecordError(
        value.workspace,
        home,
        baseDir,
        `agents[${String(index)}].workspace`,
        errors,
      ),
    },
  }));

  return { storage, runtimes, agents: expandedAgents, errors };
}
