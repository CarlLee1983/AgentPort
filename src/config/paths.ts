import { join, isAbsolute } from "node:path";

export type Env = Record<string, string | undefined>;

/**
 * 決定設定檔路徑：`--config` → `$AGENTPORT_CONFIG` → XDG 預設路徑。
 */
export function resolveConfigPath(
  cliArg: string | undefined,
  env: Env,
): string {
  if (cliArg) {
    return cliArg;
  }
  if (env.AGENTPORT_CONFIG) {
    return env.AGENTPORT_CONFIG;
  }
  const configHome = env.XDG_CONFIG_HOME ?? join(env.HOME ?? "", ".config");
  return join(configHome, "agentport", "agentport.toml");
}

export interface ExpandPathOptions {
  home: string | undefined;
  baseDir: string;
}

/**
 * `~` 展開時若 `home` 未設定，代表無法安全展開，由呼叫端轉成 ConfigError。
 */
export class HomeNotSetError extends Error {}

/**
 * 展開 `~`（相對於 `home`），並讓相對路徑相對於 `baseDir`（設定檔所在目錄）。
 */
export function expandPath(path: string, options: ExpandPathOptions): string {
  let expanded = path;
  if (expanded === "~" || expanded.startsWith("~/")) {
    if (options.home === undefined) {
      throw new HomeNotSetError(`HOME 未設定，無法展開路徑中的 ~：${path}`);
    }
    expanded = join(options.home, expanded.slice(1));
  }
  if (!isAbsolute(expanded)) {
    expanded = join(options.baseDir, expanded);
  }
  return expanded;
}
