import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { basename, dirname, join } from "node:path";

import { loadConfig, type ConfigError } from "../config/load.js";
import type { Env } from "../config/paths.js";
import type { Config } from "../config/schema.js";

const ENV_FILE_NAME = "agentport.env";

export interface PreparedToken {
  callerName: string;
  tokenEnv: string;
  value: string;
}

export interface PrepareConfigurationInput {
  configPath: string;
  env: Env;
  generateToken: () => string;
  /** Validate the planned install without creating a skeleton, env file, or tokens. */
  dryRun?: boolean;
}

export type PrepareConfigurationResult =
  | { kind: "needs-configuration"; configPath: string }
  | {
      kind: "invalid-configuration";
      configPath: string;
      errors: ConfigError[];
    }
  | {
      kind: "configured";
      configPath: string;
      config: Config;
      envPath: string;
      createdTokens: PreparedToken[];
      envPermissionTightened: boolean;
    };

/** Load a service config with the caller tokens kept in its sibling env file. */
export async function loadServiceConfig(
  configPath: string,
  env: Env,
): Promise<ReturnType<typeof loadConfig>> {
  const envPath = join(dirname(configPath), ENV_FILE_NAME);
  const serviceEnv = await readEnvironmentFile(envPath);
  return loadConfig(configPath, { ...env, ...serviceEnv.values });
}

/**
 * 將 service install 所需的設定準備成可驗證狀態。此模組不輸出任何訊息，讓
 * CLI 決定如何顯示骨架路徑、驗證錯誤與只顯示一次的新 token。
 */
export async function prepareConfiguration(
  input: PrepareConfigurationInput,
): Promise<PrepareConfigurationResult> {
  const rawConfig = await readOrCreateSkeleton(input.configPath, input.dryRun);
  if (rawConfig === undefined) {
    return { kind: "needs-configuration", configPath: input.configPath };
  }

  const envPath = join(dirname(input.configPath), ENV_FILE_NAME);
  const existingEnv = await readEnvironmentFile(envPath);
  const candidateTokens = tokenCandidates(
    rawConfig,
    existingEnv.values,
    input.generateToken,
  );
  const validationEnv: Env = {
    ...input.env,
    ...existingEnv.values,
    ...candidateTokens,
  };
  const loaded = loadConfig(input.configPath, validationEnv);
  if (!loaded.ok) {
    return {
      kind: "invalid-configuration",
      configPath: input.configPath,
      errors: loaded.errors,
    };
  }

  const createdTokens = loaded.config.callers.flatMap((caller) => {
    if (Object.hasOwn(existingEnv.values, caller.token_env)) {
      return [];
    }
    const value = candidateTokens[caller.token_env];
    if (value === undefined) {
      return [];
    }
    return [{ callerName: caller.name, tokenEnv: caller.token_env, value }];
  });

  if (input.dryRun) {
    return {
      kind: "configured",
      configPath: input.configPath,
      config: loaded.config,
      envPath,
      createdTokens: [],
      envPermissionTightened: false,
    };
  }

  if (existingEnv.exists) {
    if (createdTokens.length > 0 || existingEnv.wasBroaderThan0600) {
      await replaceEnvironmentFile(
        envPath,
        environmentContents(existingEnv.contents, createdTokens),
        true,
      );
    }
    return {
      kind: "configured",
      configPath: input.configPath,
      config: loaded.config,
      envPath,
      createdTokens,
      envPermissionTightened: existingEnv.wasBroaderThan0600,
    };
  }

  await replaceEnvironmentFile(
    envPath,
    environmentContents("", createdTokens),
    false,
  );
  return {
    kind: "configured",
    configPath: input.configPath,
    config: loaded.config,
    envPath,
    createdTokens,
    envPermissionTightened: false,
  };
}

async function readOrCreateSkeleton(
  path: string,
  dryRun: boolean | undefined,
): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  if (dryRun) {
    return undefined;
  }

  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, CONFIG_SKELETON, { encoding: "utf8", flag: "wx" });
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    return readFile(path, "utf8");
  }
}

async function readEnvironmentFile(path: string): Promise<{
  exists: boolean;
  contents: string;
  values: Env;
  wasBroaderThan0600: boolean;
}> {
  try {
    const fileStat = await lstat(path);
    if (!fileStat.isFile()) {
      throw new Error(`env 檔必須是一般檔案：${path}`);
    }
    const contents = await readFile(path, "utf8");
    return {
      exists: true,
      contents,
      values: parseEnvironment(contents),
      wasBroaderThan0600: (fileStat.mode & 0o777) !== 0o600,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        exists: false,
        contents: "",
        values: {},
        wasBroaderThan0600: false,
      };
    }
    throw error;
  }
}

/** Keeps the original env file untouched; this parser only supplies loadConfig. */
function parseEnvironment(contents: string): Env {
  const values: Env = {};
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u,
    );
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    if (key === undefined || rawValue === undefined) {
      continue;
    }
    values[key] = unquoteEnvironmentValue(rawValue);
  }
  return values;
}

function unquoteEnvironmentValue(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function tokenCandidates(
  rawConfig: string,
  existingEnv: Env,
  generateToken: () => string,
): Env {
  let parsed: unknown;
  try {
    parsed = parseToml(rawConfig);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.callers)) {
    return {};
  }

  const candidates: Env = {};
  for (const caller of parsed.callers) {
    if (!isRecord(caller) || typeof caller.token_env !== "string") {
      continue;
    }
    if (!Object.hasOwn(existingEnv, caller.token_env)) {
      candidates[caller.token_env] ??= generateToken();
    }
  }
  return candidates;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function environmentContents(
  existingContents: string,
  tokens: PreparedToken[],
): string {
  const prefix =
    existingContents === "" || existingContents.endsWith("\n") ? "" : "\n";
  const additions = tokens
    .map((token) => `${token.tokenEnv}=${token.value}`)
    .join("\n");
  return additions === ""
    ? existingContents
    : `${existingContents}${prefix}${additions}\n`;
}

/**
 * Existing credential files are never opened for writing. A 0600 sibling is
 * fully written first, then atomically renamed over the verified regular file.
 * For a first install, link(2) gives the final name an exclusive creation step.
 */
async function replaceEnvironmentFile(
  path: string,
  contents: string,
  replaceExisting: boolean,
): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporaryPath, 0o600);
    if (replaceExisting) {
      await rename(temporaryPath, path);
    } else {
      await link(temporaryPath, path);
      // Publication already succeeded; a leftover private temp file must not
      // turn this install into a failure that suppresses the one-time token.
      await rm(temporaryPath).catch(() => undefined);
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

const CONFIG_SKELETON = `# AgentPort service configuration\n#\n# [server]\n# listen = "127.0.0.1:3333"\n#\n# [storage]\n# db_path = "~/.local/state/agentport/agentport.sqlite"\n# log_dir = "~/.local/state/agentport/logs"\n#\n# [[agents]]\n# name = "my-agent"\n# workspace = "/absolute/path/to/workspace"\n# runtime = "claude"\n# policy = "workspace-write"\n\n[[callers]]\nname = "default"\ntoken_env = "AGENTPORT_TOKEN_DEFAULT"\n`;
